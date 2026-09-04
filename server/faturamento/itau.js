const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 20000;
const JSON_MAX_BYTES = 1024 * 1024;
const TOKEN_URL = 'https://sts.itau.com.br/api/oauth/token';
const API_BASE_URL = 'https://api.gateway.itau.com.br/cash_management/v2';
const BOLETO_PATH = 'boletos';
const ITAU_ISSUER_CNPJ = '97434690000129';
const ITAU_ISSUER_NAME = 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA';
const BOLETO_STAGES = new Set(['validacao', 'efetivacao']);

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

const digits = (value) => String(value || '').replace(/\D/g, '');

const itauBoletoConfig = (env = process.env) => {
  const config = itauConfig(env);
  const beneficiaryId = digits(env.ITAU_BENEFICIARY_ID);
  const wallet = digits(env.ITAU_BOLETO_WALLET);
  const stage = String(env.ITAU_BOLETO_STAGE || 'validacao').trim().toLowerCase();
  const species = digits(env.ITAU_BOLETO_SPECIES || '01');
  const acceptance = String(env.ITAU_BOLETO_ACCEPTANCE || 'N').trim().toUpperCase();

  if (beneficiaryId.length !== 12) {
    throw configurationError(
      'ITAU_BENEFICIARY_ID deve conter agência (4), conta (7) e DAC (1), totalizando 12 dígitos.'
    );
  }
  if (wallet.length !== 3) {
    throw configurationError('ITAU_BOLETO_WALLET deve conter os 3 dígitos da carteira Itaú.');
  }
  if (!BOLETO_STAGES.has(stage)) {
    throw configurationError('ITAU_BOLETO_STAGE deve ser validacao ou efetivacao.');
  }
  if (species.length !== 2) {
    throw configurationError('ITAU_BOLETO_SPECIES deve conter 2 dígitos.');
  }
  if (!['S', 'N'].includes(acceptance)) {
    throw configurationError('ITAU_BOLETO_ACCEPTANCE deve ser S ou N.');
  }

  return {
    ...config,
    beneficiaryId,
    beneficiaryName: String(env.ITAU_BENEFICIARY_NAME || ITAU_ISSUER_NAME).trim(),
    beneficiaryTaxId: digits(env.ITAU_BENEFICIARY_CNPJ || ITAU_ISSUER_CNPJ),
    wallet,
    stage,
    species,
    acceptance
  };
};

const safeUpstreamMessage = (payload, fallback) => {
  const firstIssue = [
    ...(Array.isArray(payload?.errors) ? payload.errors : []),
    ...(Array.isArray(payload?.erros) ? payload.erros : []),
    ...(Array.isArray(payload?.violacoes) ? payload.violacoes : []),
    ...(Array.isArray(payload?.campos) ? payload.campos : [])
  ].find((value) => value && typeof value === 'object');
  const candidates = [
    payload?.message,
    payload?.mensagem,
    payload?.data?.message,
    payload?.data?.mensagem,
    firstIssue?.message,
    firstIssue?.mensagem,
    firstIssue?.detail,
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
    statusCode: [400, 404, 405, 422, 428].includes(result.statusCode)
      ? 422
      : (result.statusCode === 429 ? 503 : 502),
    upstreamStatus: result.statusCode,
    receivedResponse: true,
    expose: [400, 404, 405, 422, 428].includes(result.statusCode)
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
    try {
      return await request({
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
    } catch (error) {
      error.bankRequestStarted = true;
      throw error;
    }
  };

  let result = await execute(false);
  if (result.statusCode === 401) result = await execute(true);
  return result;
};

const boletoFromPayload = (payload) => {
  const candidates = [
    payload?.data,
    payload?.value?.data,
    payload?.value?.value?.data,
    payload
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const item = candidate.find((value) => value && typeof value === 'object');
      if (item) return item;
    }
    if (candidate && typeof candidate === 'object' && (
      candidate.id_boleto || candidate.dado_boleto || candidate.beneficiario
    )) return candidate;
  }
  return null;
};

const itauAmount = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  if (/[.,]/.test(text)) return Number(text.replace(',', '.'));
  return /^\d+$/.test(text) ? Number(text) / 100 : NaN;
};

const normalizeItauBankSlip = (payload, requestedStage = '') => {
  const boleto = boletoFromPayload(payload);
  if (!boleto) return null;
  const details = Array.isArray(boleto?.dado_boleto?.dados_individuais_boleto)
    ? boleto.dado_boleto.dados_individuais_boleto[0]
    : null;
  const stage = String(boleto.etapa_processo_boleto || requestedStage || '').toLowerCase();
  return {
    id: String(boleto.id_boleto || '').trim(),
    stage,
    registered: stage === 'efetivacao',
    beneficiaryId: String(boleto?.beneficiario?.id_beneficiario || '').trim(),
    wallet: String(boleto?.dado_boleto?.codigo_carteira || '').trim(),
    ourNumber: String(details?.numero_nosso_numero || '').trim(),
    yourNumber: String(details?.texto_seu_numero || '').trim(),
    amount: itauAmount(details?.valor_titulo || boleto?.dado_boleto?.valor_total_titulo),
    dueDate: String(details?.data_vencimento || '').trim(),
    digitableLine: String(details?.numero_linha_digitavel || '').trim(),
    barCode: String(details?.codigo_barras || '').trim(),
    raw: payload
  };
};

const createItauBankSlip = async (payload, options = {}) => {
  const config = options.config || itauBoletoConfig();
  let result;
  try {
    result = await authenticatedRequest({
      method: 'POST',
      path: BOLETO_PATH,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      ...options,
      config
    });
  } catch (error) {
    if (error.bankRequestStarted) error.ambiguousBankState = true;
    throw error;
  }

  let response;
  try {
    response = jsonFromResponse(result);
  } catch (error) {
    if (result.statusCode >= 200 && result.statusCode < 300) error.ambiguousBankState = true;
    throw error;
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const error = itauHttpError(result, response, 'O Itaú recusou a emissão do boleto.');
    if (result.statusCode >= 500) error.ambiguousBankState = true;
    throw error;
  }

  const bankSlip = normalizeItauBankSlip(response, payload?.etapa_processo_boleto);
  if (!bankSlip) {
    throw Object.assign(new Error('O Itaú não retornou os dados do boleto.'), {
      statusCode: 502,
      receivedResponse: true,
      ambiguousBankState: config.stage === 'efetivacao'
    });
  }
  return bankSlip;
};

const queryItauBankSlips = async (criteria = {}, options = {}) => {
  const config = options.config || itauBoletoConfig();
  const beneficiaryId = digits(criteria.beneficiaryId || config.beneficiaryId);
  if (beneficiaryId.length !== 12) throw configurationError('Código do beneficiário Itaú inválido.');
  const params = new URLSearchParams({ id_beneficiario: beneficiaryId });
  const wallet = digits(criteria.wallet);
  const ourNumber = digits(criteria.ourNumber);
  const inclusionDate = String(criteria.inclusionDate || '').trim();
  const view = String(criteria.view || 'full');
  if (wallet && wallet.length !== 3) throw configurationError('Carteira Itaú inválida para consulta.');
  if (ourNumber && (ourNumber.length < 8 || ourNumber.length > 16)) {
    throw configurationError('Nosso número Itaú inválido para consulta.');
  }
  if (inclusionDate && !/^\d{4}-\d{2}-\d{2}$/.test(inclusionDate)) {
    throw configurationError('Data de inclusão inválida para consulta Itaú.');
  }
  if (!['basic', 'full', 'specific'].includes(view)) {
    throw configurationError('Visão inválida para consulta Itaú.');
  }
  if (wallet) params.set('codigo_carteira', wallet);
  if (ourNumber) params.set('nosso_numero', ourNumber);
  if (inclusionDate) params.set('data_inclusao', inclusionDate);
  params.set('view', view);

  const result = await authenticatedRequest({
    method: 'GET',
    path: `${BOLETO_PATH}?${params}`,
    headers: { Accept: 'application/json' },
    ...options,
    config
  });
  if (result.statusCode === 204) return [];
  const response = jsonFromResponse(result);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw itauHttpError(result, response, 'Não foi possível consultar o boleto no Itaú.');
  }
  const candidates = [
    response?.data,
    response?.value?.data,
    response?.value?.value?.data
  ];
  const list = candidates.find(Array.isArray) || [];
  return list.map((item) => normalizeItauBankSlip({ data: item })).filter(Boolean);
};

const resetTokenCache = () => {
  cachedToken = '';
  cachedTokenExpiresAt = 0;
  cachedTokenConfigKey = '';
};

module.exports = {
  TOKEN_URL,
  API_BASE_URL,
  BOLETO_PATH,
  REQUEST_TIMEOUT_MS,
  itauConfig,
  itauBoletoConfig,
  httpsRequest,
  jsonFromResponse,
  requestAccessToken,
  authenticatedRequest,
  boletoFromPayload,
  itauAmount,
  normalizeItauBankSlip,
  createItauBankSlip,
  queryItauBankSlips,
  resetTokenCache
};
