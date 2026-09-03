const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 20000;
const JSON_MAX_BYTES = 1024 * 1024;
const TOKEN_URL = 'https://sts.itau.com.br/api/oauth/token';
const API_BASE_URL = 'https://secure.gateway.api.itau';

let cachedToken = '';
let cachedTokenExpiresAt = 0;
let cachedTokenConfigKey = '';

const configurationError = (message) =>
  Object.assign(new Error(message), { statusCode: 503, expose: true });

const decodeBase64Pem = (value, label, acceptedMarkers) => {
  const normalized = String(value || '').replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw configurationError(`${label} do Itaú não configurado.`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  const pem = decoded.toString('utf8');
  if (!decoded.length || !acceptedMarkers.some((marker) => pem.includes(marker))) {
    throw configurationError(`${label} do Itaú inválido.`);
  }
  return decoded;
};

const normalizedHttpsUrl = (value, fallback, label) => {
  let url;
  try {
    url = new URL(String(value || fallback).trim());
  } catch {
    throw configurationError(`${label} do Itaú inválida.`);
  }
  if (url.protocol !== 'https:') throw configurationError(`${label} do Itaú deve utilizar HTTPS.`);
  return url.toString().replace(/\/$/, '');
};

const itauConfig = (env = process.env) => {
  const clientId = String(env.ITAU_CLIENT_ID || '').trim();
  const clientSecret = String(env.ITAU_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw configurationError('Credenciais da API Itaú não configuradas.');
  }

  const cert = decodeBase64Pem(
    env.ITAU_MTLS_CERT_BASE64,
    'Certificado mTLS',
    ['-----BEGIN CERTIFICATE-----']
  );
  const key = decodeBase64Pem(
    env.ITAU_MTLS_KEY_BASE64,
    'Chave privada mTLS',
    ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----']
  );
  const passphrase = String(env.ITAU_MTLS_KEY_PASSPHRASE || '');
  const tokenUrl = normalizedHttpsUrl(env.ITAU_TOKEN_URL, TOKEN_URL, 'URL de autenticação');
  const apiBaseUrl = normalizedHttpsUrl(env.ITAU_API_BASE_URL, API_BASE_URL, 'URL da API');
  const apiKey = String(env.ITAU_API_KEY || clientId).trim();
  const tokenConfigKey = createHash('sha256')
    .update(`${tokenUrl}:${clientId}:${clientSecret}:`)
    .update(cert)
    .update(key)
    .digest('hex');

  return {
    clientId,
    clientSecret,
    cert,
    key,
    passphrase,
    tokenUrl,
    apiBaseUrl,
    apiKey,
    tokenConfigKey
  };
};

const safeUpstreamMessage = (payload, fallback) => {
  const candidates = [
    payload?.message,
    payload?.mensagem,
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
        request.destroy(Object.assign(new Error('Resposta do Itaú excedeu o limite permitido.'), {
          statusCode: 502,
          receivedResponse: true
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
    request.destroy(Object.assign(new Error('Tempo esgotado ao acessar o Itaú.'), {
      statusCode: 504
    }));
  });
  request.on('error', (error) => {
    if (!error.statusCode) error.statusCode = 502;
    reject(error);
  });
  if (payload) request.write(payload);
  request.end();
});

const jsonFromResponse = (result) => {
  try {
    return JSON.parse(result.body.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('O Itaú retornou uma resposta inválida.'), {
      statusCode: 502,
      receivedResponse: true,
      upstreamStatus: result.statusCode
    });
  }
};

const itauHttpError = (result, payload, fallback) => Object.assign(
  new Error(safeUpstreamMessage(payload, fallback)),
  {
    statusCode: result.statusCode === 429 ? 503 : 502,
    upstreamStatus: result.statusCode,
    receivedResponse: true
  }
);

const requestAccessToken = async (config, request = httpsRequest) => {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret
  }).toString();
  const result = await request({
    url: config.tokenUrl,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-itau-correlationID': randomUUID(),
      'x-itau-flowID': randomUUID()
    },
    body,
    config
  });
  const payload = jsonFromResponse(result);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw itauHttpError(result, payload, 'Falha de autenticação no Itaú.');
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw Object.assign(new Error('O Itaú não retornou um token de acesso.'), {
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
  config = itauConfig(),
  request = httpsRequest
}) => {
  const execute = async (forceRefresh = false) => {
    const token = await getAccessToken(config, forceRefresh, request);
    return request({
      url: new URL(path, `${config.apiBaseUrl}/`).toString(),
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'x-itau-apikey': config.apiKey,
        'x-itau-correlationID': randomUUID(),
        'x-itau-flowID': randomUUID(),
        ...headers
      },
      body,
      maxBytes,
      config
    });
  };

  let result = await execute(false);
  if (result.statusCode === 401) result = await execute(true);
  return result;
};

const resetTokenCache = () => {
  cachedToken = '';
  cachedTokenExpiresAt = 0;
  cachedTokenConfigKey = '';
};

module.exports = {
  TOKEN_URL,
  API_BASE_URL,
  REQUEST_TIMEOUT_MS,
  itauConfig,
  httpsRequest,
  jsonFromResponse,
  requestAccessToken,
  authenticatedRequest,
  resetTokenCache
};
