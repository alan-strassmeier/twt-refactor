const forge = require('node-forge');

const ENVIRONMENTS = Object.freeze({
  homologation: Object.freeze({
    type: '2',
    baseUrl: 'https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional'
  }),
  production: Object.freeze({
    type: '1',
    baseUrl: 'https://sefin.nfse.gov.br/SefinNacional'
  })
});

const configurationError = (message) =>
  Object.assign(new Error(message), { statusCode: 503, expose: true });

const decodeBase64 = (value, label) => {
  const normalized = String(value || '').replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw configurationError(`${label} da NFS-e não configurado.`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (!decoded.length) throw configurationError(`${label} da NFS-e inválido.`);
  return decoded;
};

const certificateMaterialFromPfx = (pfx, passphrase = '') => {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })
        [forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])
    ];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })
      [forge.pki.oids.certBag] || [];
    const privateKey = keyBags.find((bag) => bag.key)?.key;
    const matchingCertificate = privateKey && certBags.find((bag) => {
      const publicKey = bag.cert?.publicKey;
      return publicKey?.n?.compareTo?.(privateKey.n) === 0 &&
        publicKey?.e?.compareTo?.(privateKey.e) === 0;
    });
    const certificate = matchingCertificate?.cert || certBags.find((bag) => bag.cert)?.cert;
    if (!privateKey || !certificate) throw new Error('Chave privada ou certificado ausente.');
    const certificatePem = forge.pki.certificateToPem(certificate);
    return {
      privateKeyPem: forge.pki.privateKeyToPem(privateKey),
      certificatePem,
      certificateBase64: certificatePem
        .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '')
    };
  } catch (error) {
    throw configurationError(`Certificado A1 da NFS-e inválido: ${error.message}`);
  }
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum
    ? Math.min(number, maximum)
    : fallback;
};

const certificateModeFromEnv = (env = process.env) => {
  const mode = String(env.NFSE_CERT_MODE || 'a1').trim().toLowerCase();
  if (!['a1', 'agent'].includes(mode)) {
    throw configurationError('NFSE_CERT_MODE deve ser a1 ou agent.');
  }
  return mode;
};

const nfseConfig = (env = process.env, options = {}) => {
  const environment = String(env.NFSE_ENVIRONMENT || 'homologation').trim().toLowerCase();
  const target = ENVIRONMENTS[environment];
  if (!target) {
    throw configurationError('NFSE_ENVIRONMENT deve ser homologation ou production.');
  }

  const series = String(env.NFSE_DPS_SERIES || '').trim();
  if (!/^\d{1,5}$/.test(series)) {
    throw configurationError('NFSE_DPS_SERIES deve ser uma série numérica exclusiva de até 5 dígitos.');
  }
  const initialNumber = Number(env.NFSE_DPS_INITIAL_NUMBER || 0);
  if (!Number.isSafeInteger(initialNumber) || initialNumber < 0 || initialNumber >= 1e15) {
    throw configurationError('NFSE_DPS_INITIAL_NUMBER deve ser um inteiro entre 0 e 999999999999999.');
  }

  const baseUrl = String(env.NFSE_API_BASE_URL || target.baseUrl).trim().replace(/\/+$/, '');
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw configurationError('NFSE_API_BASE_URL inválida.');
  }
  if (parsedBaseUrl.protocol !== 'https:') {
    throw configurationError('NFSE_API_BASE_URL deve utilizar HTTPS.');
  }

  const config = {
    certificateMode: certificateModeFromEnv(env),
    environment,
    environmentType: target.type,
    baseUrl,
    series,
    initialNumber,
    applicationVersion: String(env.NFSE_APPLICATION_VERSION || 'TWT_1.0.0').trim().slice(0, 20),
    requestTimeoutMs: boundedInteger(env.NFSE_REQUEST_TIMEOUT_MS, 30000, 5000, 55000),
    providerPhone: String(env.NFSE_PROVIDER_PHONE || '5133424425').replace(/\D/g, '').slice(0, 20),
    providerEmail: String(env.NFSE_PROVIDER_EMAIL || 'faturamento@twt.com.br').trim().slice(0, 80)
  };

  const requireCertificate = options.requireCertificate ?? config.certificateMode === 'a1';
  if (requireCertificate) {
    config.pfx = decodeBase64(env.NFSE_CERT_PFX_BASE64, 'Certificado A1');
    config.passphrase = String(env.NFSE_CERT_PASSWORD || '');
    Object.assign(config, certificateMaterialFromPfx(config.pfx, config.passphrase));
  }
  return config;
};

module.exports = {
  ENVIRONMENTS,
  configurationError,
  decodeBase64,
  certificateMaterialFromPfx,
  certificateModeFromEnv,
  nfseConfig
};
