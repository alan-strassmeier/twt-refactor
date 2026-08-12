const https = require('node:https');
const { createHash } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 20000;
const JSON_MAX_BYTES = 1024 * 1024;
const PDF_MAX_BYTES = 15 * 1024 * 1024;
const ENVIRONMENTS = {
  sandbox: {
    baseUrl: 'https://baas-api-sandbox.c6bank.info',
    billingScheme: '21'
  },
  production: {
    baseUrl: 'https://baas-api.c6bank.info',
    billingScheme: '15'
  }
};

let cachedToken = '';
let cachedTokenExpiresAt = 0;
let cachedTokenConfigKey = '';

const configurationError = (message) =>
  Object.assign(new Error(message), { statusCode: 503, expose: true });

const decodeBase64Secret = (value, label) => {
  const normalized = String(value || '').replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw configurationError(`${label} do C6 não configurado.`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (!decoded.length) throw configurationError(`${label} do C6 inválido.`);
  return decoded;
};

const c6Config = (env = process.env) => {
  const environment = String(env.C6_ENVIRONMENT || 'sandbox').trim().toLowerCase();
  const target = ENVIRONMENTS[environment];
  if (!target) {
    throw configurationError('C6_ENVIRONMENT deve ser sandbox ou production.');
  }

  const clientId = String(env.C6_CLIENT_ID || '').trim();
  const clientSecret = String(env.C6_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw configurationError('Credenciais da API C6 não configuradas.');
  }

  const cert = decodeBase64Secret(env.C6_MTLS_CERT_BASE64, 'Certificado mTLS');
  const key = decodeBase64Secret(env.C6_MTLS_KEY_BASE64, 'Chave privada mTLS');
  const passphrase = String(env.C6_MTLS_KEY_PASSPHRASE || '');
  const partnerSoftwareName = String(env.C6_PARTNER_SOFTWARE_NAME || 'TWT Faturamento')
    .trim()
    .slice(0, 100);
  const partnerSoftwareVersion = String(env.C6_PARTNER_SOFTWARE_VERSION || '1.0.0')
    .trim()
    .slice(0, 40);
  const tokenConfigKey = createHash('sha256')
    .update(`${environment}:${clientId}:`)
    .update(cert)
    .digest('hex');

  return {
    environment,
    baseUrl: target.baseUrl,
    authUrl: `${target.baseUrl}/v1/auth/`,
    bankSlipsUrl: `${target.baseUrl}/v1/bank_slips`,
    billingScheme: target.billingScheme,
    clientId,
    clientSecret,
    cert,
    key,
    passphrase,
    partnerSoftwareName,
    partnerSoftwareVersion,
    tokenConfigKey
  };
};

const safeUpstreamMessage = (payload, fallback) => {
  const candidates = [
    payload?.message,
    payload?.error_description,
    payload?.error,
    payload?.detail,
    payload?.title
  ];
  const message = candidates.find((value) => typeof value === 'string' && value.trim());
  return String(message || fallback).replace(/[\r\n]+/g, ' ').slice(0, 300);
};

const httpsRequest = ({
  url,
  method = 'GET',
  headers = {},
  body = null,
  maxBytes = JSON_MAX_BYTES,
  ambiguousOnFailure = false,
  config
}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const payload = body === null || body === undefined
    ? null
    : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  const request = https.request(target, {
    method,
    cert: config.cert,
    key: config.key,
    passphrase: config.passphrase || undefined,
    minVersion: 'TLSv1.2',
    headers: {
      ...headers,
      ...(payload ? { 'Content-Length': String(payload.length) } : {})
    }
  }, (response) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy(Object.assign(new Error('Resposta do C6 excedeu o limite permitido.'), {
          statusCode: 502,
          receivedResponse: true,
          ambiguousBankState: ambiguousOnFailure && Number(response.statusCode) >= 200 && Number(response.statusCode) < 300
        }));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve({
      statusCode: Number(response.statusCode) || 0,
      headers: response.headers,
      body: Buffer.concat(chunks)
    }));
  });
  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    request.destroy(Object.assign(new Error('Tempo esgotado ao acessar o C6.'), {
      statusCode: 504,
      ambiguousBankState: ambiguousOnFailure
    }));
  });
  request.on('error', (error) => {
    if (!error.statusCode) error.statusCode = 502;
    if (ambiguousOnFailure && error.receivedResponse !== true) error.ambiguousBankState = true;
    reject(error);
  });
  if (payload) request.write(payload);
  request.end();
});

const jsonFromResponse = (result) => {
  try {
    return JSON.parse(result.body.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('O C6 retornou uma resposta inválida.'), {
      statusCode: 502,
      receivedResponse: true,
      upstreamStatus: result.statusCode
    });
  }
};

const c6HttpError = (result, payload, fallback) => Object.assign(
  new Error(safeUpstreamMessage(payload, fallback)),
  {
    statusCode: result.statusCode === 429 ? 503 : 502,
    upstreamStatus: result.statusCode,
    receivedResponse: true
  }
);

const requestAccessToken = async (config, request = httpsRequest) => {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'client_credentials'
  }).toString();
  const result = await request({
    url: config.authUrl,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    config
  });
  const payload = jsonFromResponse(result);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw c6HttpError(result, payload, 'Falha de autenticação no C6.');
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw Object.assign(new Error('O C6 não retornou um token de acesso.'), {
      statusCode: 502,
      receivedResponse: true
    });
  }
  const expiresIn = Number(payload.expires_in);
  return {
    token: payload.access_token,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300
  };
};

const getAccessToken = async (config, forceRefresh = false, request = httpsRequest) => {
  if (
    !forceRefresh &&
    cachedToken &&
    cachedTokenConfigKey === config.tokenConfigKey &&
    Date.now() < cachedTokenExpiresAt
  ) return cachedToken;

  const result = await requestAccessToken(config, request);
  cachedToken = result.token;
  cachedTokenConfigKey = config.tokenConfigKey;
  cachedTokenExpiresAt = Date.now() + Math.max((result.expiresIn * 1000) - 30000, 15000);
  return cachedToken;
};

const authenticatedRequest = async ({
  path = '',
  method = 'GET',
  headers = {},
  body = null,
  maxBytes = JSON_MAX_BYTES,
  ambiguousOnFailure = false,
  config = c6Config(),
  request = httpsRequest
}) => {
  const execute = async (forceRefresh = false) => {
    const token = await getAccessToken(config, forceRefresh, request);
    return request({
      url: `${config.bankSlipsUrl}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'partner-software-name': config.partnerSoftwareName,
        'partner-software-version': config.partnerSoftwareVersion,
        ...headers
      },
      body,
      maxBytes,
      ambiguousOnFailure,
      config
    });
  };

  let result = await execute(false);
  if (result.statusCode === 401) result = await execute(true);
  return result;
};

const createC6BankSlip = async (payload, options = {}) => {
  const result = await authenticatedRequest({
    method: 'POST',
    path: '/',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    ambiguousOnFailure: true,
    ...options
  });
  let response;
  try {
    response = jsonFromResponse(result);
  } catch (error) {
    if (result.statusCode === 201) error.ambiguousBankState = true;
    throw error;
  }
  if (result.statusCode !== 201) {
    const error = c6HttpError(result, response, 'O C6 recusou a emissão do boleto.');
    if (result.statusCode >= 500) error.ambiguousBankState = true;
    throw error;
  }
  return response;
};

const getC6BankSlipPdf = async (bankSlipId, options = {}) => {
  const normalizedId = String(bankSlipId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(normalizedId)) {
    throw Object.assign(new Error('Identificador do boleto inválido.'), { statusCode: 422 });
  }
  const result = await authenticatedRequest({
    method: 'GET',
    path: `/${encodeURIComponent(normalizedId)}/pdf`,
    headers: {
      Accept: 'application/pdf',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    maxBytes: PDF_MAX_BYTES,
    ...options
  });
  if (result.statusCode !== 200 || !result.body.length) {
    let payload = {};
    try { payload = jsonFromResponse(result); } catch { /* usa mensagem genérica */ }
    throw c6HttpError(result, payload, 'Não foi possível baixar o boleto no C6.');
  }
  return result.body;
};

const resetTokenCache = () => {
  cachedToken = '';
  cachedTokenExpiresAt = 0;
  cachedTokenConfigKey = '';
};

module.exports = {
  ENVIRONMENTS,
  REQUEST_TIMEOUT_MS,
  c6Config,
  httpsRequest,
  requestAccessToken,
  authenticatedRequest,
  createC6BankSlip,
  getC6BankSlipPdf,
  resetTokenCache
};
