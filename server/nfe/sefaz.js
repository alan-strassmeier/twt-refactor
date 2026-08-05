const https = require('node:https');
const tls = require('node:tls');
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { XMLParser } = require('fast-xml-parser');
const {
  isConfigured: redisAvailable,
  command: sharedRedisCommand
} = require('../shared/redis');

const PRODUCTION_URL =
  'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const SOAP_ACTION =
  'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';
const REQUEST_TIMEOUT_MS = 25000;
const CERTIFICATE_ERROR_STATUSES = new Set(['280', '281', '282', '283', '286', '593']);
const HOURLY_QUERY_LIMIT = 20;
const SUCCESS_CACHE_SECONDS = 24 * 60 * 60;
const NEGATIVE_CACHE_SECONDS = 60 * 60;
const memoryCache = new Map();
const memoryQueries = [];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: true,
  textNodeName: '#text',
  trimValues: true
});

const createHttpError = (message, statusCode = 502) =>
  Object.assign(new Error(message), { statusCode });

const digits = (value) => String(value || '').replace(/\D/g, '');
const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const certificateConfig = () => {
  const encodedPfx = String(process.env.SEFAZ_CERTIFICATE_PFX_BASE64 || '')
    .replace(/\s/g, '');
  const passphrase = String(process.env.SEFAZ_CERTIFICATE_PASSWORD || '');
  const actorCnpj = digits(process.env.SEFAZ_ACTOR_CNPJ || '97434690000129');
  const authorStateCode = digits(process.env.SEFAZ_AUTHOR_UF_CODE || '43');

  if (!encodedPfx || !passphrase) {
    throw createHttpError('O certificado digital A1 da TWT ainda não foi configurado.', 503);
  }
  if (actorCnpj.length !== 14 || !/^\d{2}$/.test(authorStateCode)) {
    throw createHttpError('Os dados do certificado da TWT estão incompletos.', 503);
  }

  let pfx;
  try {
    pfx = Buffer.from(encodedPfx, 'base64');
  } catch {
    throw createHttpError('O certificado digital A1 configurado é inválido.', 503);
  }
  if (!pfx.length) throw createHttpError('O certificado digital A1 configurado é inválido.', 503);
  return { pfx, passphrase, actorCnpj, authorStateCode };
};

const redisCommand = async (...args) => {
  try {
    return await sharedRedisCommand(...args);
  } catch {
    throw createHttpError('Não foi possível validar o limite seguro de consultas à SEFAZ.', 503);
  }
};

const cacheKey = (accessKey) =>
  `nfe:sefaz:cache:${createHash('sha256').update(accessKey).digest('hex')}`;

const cacheEncryptionKey = () => {
  const secret = String(process.env.NFE_SESSION_SECRET || '');
  if (secret.length < 32) {
    throw createHttpError('A chave de proteção do cache de NF-e não foi configurada.', 503);
  }
  return createHash('sha256').update(secret).digest();
};

const encryptCache = (value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cacheEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  });
};

const decryptCache = (value) => {
  try {
    const payload = JSON.parse(value);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      cacheEncryptionKey(),
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final()
    ]).toString('utf8'));
  } catch {
    return null;
  }
};

const getCachedResult = async (accessKey) => {
  const key = cacheKey(accessKey);
  if (redisAvailable()) {
    const encrypted = await redisCommand('GET', key);
    if (encrypted) return decryptCache(encrypted);
  }
  const local = memoryCache.get(key);
  if (!local || local.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return local.value;
};

const saveCachedResult = async (accessKey, value, ttlSeconds) => {
  const key = cacheKey(accessKey);
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000
  });
  if (redisAvailable()) {
    await redisCommand('SET', key, encryptCache(value), 'EX', ttlSeconds);
  }
};

const enforceHourlyQueryLimit = async (actorCnpj) => {
  if (redisAvailable()) {
    const digest = createHash('sha256').update(actorCnpj).digest('hex');
    const key = `nfe:sefaz:quota:${digest}`;
    const count = Number(await redisCommand(
      'EVAL',
      "local current=redis.call('INCR',KEYS[1]); if current==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return current",
      '1',
      key,
      '3600'
    ));
    if (count > HOURLY_QUERY_LIMIT) {
      throw createHttpError(
        'O limite oficial de 20 consultas à SEFAZ por hora foi atingido. Aguarde antes de enviar outro lote.',
        429
      );
    }
    return;
  }

  const cutoff = Date.now() - 60 * 60 * 1000;
  while (memoryQueries.length && memoryQueries[0] <= cutoff) memoryQueries.shift();
  if (memoryQueries.length >= HOURLY_QUERY_LIMIT) {
    throw createHttpError(
      'O limite oficial de 20 consultas à SEFAZ por hora foi atingido. Aguarde antes de enviar outro lote.',
      429
    );
  }
  memoryQueries.push(Date.now());
};

const buildRequestEnvelope = (accessKey, config) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soap:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>1</tpAmb>
          <cUFAutor>${escapeXml(config.authorStateCode)}</cUFAutor>
          <CNPJ>${escapeXml(config.actorCnpj)}</CNPJ>
          <consChNFe>
            <chNFe>${escapeXml(accessKey)}</chNFe>
          </consChNFe>
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap:Body>
</soap:Envelope>`;

const defaultTransport = (envelope, config) => new Promise((resolve, reject) => {
  try {
    tls.createSecureContext({
      pfx: config.pfx,
      passphrase: config.passphrase,
      minVersion: 'TLSv1.2'
    });
  } catch {
    reject(createHttpError('O certificado digital A1 ou sua senha são inválidos.', 503));
    return;
  }

  const url = new URL(PRODUCTION_URL);
  const request = https.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    pfx: config.pfx,
    passphrase: config.passphrase,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Accept: 'text/xml',
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${SOAP_ACTION}"`,
      'Content-Length': Buffer.byteLength(envelope)
    }
  }, (response) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) {
        request.destroy(createHttpError('A resposta da SEFAZ excedeu o limite permitido.'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(createHttpError(
          response.statusCode === 403
            ? 'A SEFAZ recusou o certificado digital da TWT.'
            : 'A SEFAZ não conseguiu atender à consulta.'
        ));
        return;
      }
      resolve(body);
    });
  });
  request.on('timeout', () => request.destroy(
    createHttpError('A consulta à SEFAZ excedeu o tempo limite.', 504)
  ));
  request.on('error', (error) => {
    if (error.statusCode) reject(error);
    else reject(createHttpError('Não foi possível conectar ao Ambiente Nacional da SEFAZ.'));
  });
  request.end(envelope);
});

let transport = defaultTransport;

const findNode = (value, key) => {
  if (!value || typeof value !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findNode(child, key);
    if (found) return found;
  }
  return null;
};

const asArray = (value) => value == null ? [] : (Array.isArray(value) ? value : [value]);

const parseSoapResponse = (soapXml) => {
  let parsed;
  try {
    parsed = parser.parse(String(soapXml || ''));
  } catch {
    throw createHttpError('A SEFAZ retornou uma resposta inválida.');
  }

  const fault = findNode(parsed, 'Fault');
  if (fault) {
    throw createHttpError(
      String(fault.faultstring || fault.Reason?.Text || 'A SEFAZ recusou a consulta.')
    );
  }

  const result = findNode(parsed, 'retDistDFeInt');
  if (!result) throw createHttpError('A resposta da SEFAZ não contém o resultado esperado.');
  const status = String(result.cStat || '');
  const reason = String(result.xMotivo || '').trim();

  if (status === '656') {
    throw createHttpError(
      'A SEFAZ bloqueou temporariamente novas consultas por consumo indevido. Aguarde uma hora.',
      429
    );
  }
  if (CERTIFICATE_ERROR_STATUSES.has(status)) {
    throw createHttpError(reason || 'A SEFAZ recusou o certificado digital da TWT.', 503);
  }
  if (status !== '138') {
    throw createHttpError(
      status === '137'
        ? 'NF-e não localizada ou ainda não liberada para o CNPJ da TWT.'
        : (reason || 'A SEFAZ não disponibilizou o XML desta NF-e.'),
      status === '137' ? 404 : 422
    );
  }

  const documents = asArray(result.loteDistDFeInt?.docZip);
  for (const document of documents) {
    const schema = String(document?.['@_schema'] || '');
    if (!/^procNFe_/i.test(schema)) continue;
    const compressed = typeof document === 'string' ? document : document?.['#text'];
    if (!compressed) continue;
    try {
      const xml = gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8');
      if (/<(?:\w+:)?nfeProc\b/i.test(xml)) return xml;
    } catch {
      throw createHttpError('A SEFAZ retornou um XML compactado inválido.');
    }
  }

  throw createHttpError(
    'A SEFAZ localizou a NF-e, mas ainda não liberou o XML completo para o CNPJ da TWT.',
    403
  );
};

const fetchXmlByKey = async (accessKey) => {
  const config = certificateConfig();
  const cached = await getCachedResult(accessKey);
  if (cached?.xml) return cached.xml;
  if (cached?.error) throw createHttpError(cached.error, cached.statusCode || 422);

  await enforceHourlyQueryLimit(config.actorCnpj);
  const envelope = buildRequestEnvelope(accessKey, config);
  try {
    const response = await transport(envelope, config);
    const xml = parseSoapResponse(response);
    await saveCachedResult(accessKey, { xml }, SUCCESS_CACHE_SECONDS);
    return xml;
  } catch (error) {
    if ([403, 404].includes(Number(error.statusCode))) {
      await saveCachedResult(accessKey, {
        error: error.message,
        statusCode: error.statusCode
      }, NEGATIVE_CACHE_SECONDS);
    }
    throw error;
  }
};

const setTransportForTests = (nextTransport) => {
  transport = nextTransport || defaultTransport;
};

const resetMemoryForTests = () => {
  memoryCache.clear();
  memoryQueries.splice(0, memoryQueries.length);
};

module.exports = {
  PRODUCTION_URL,
  SOAP_ACTION,
  HOURLY_QUERY_LIMIT,
  buildRequestEnvelope,
  parseSoapResponse,
  fetchXmlByKey,
  setTransportForTests,
  resetMemoryForTests
};
