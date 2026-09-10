const https = require('node:https');
const { createHash } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 20000;
const JSON_MAX_BYTES = 1024 * 1024;
const TWT_ISSUER_CNPJ = '09123137000108';
const TWT_ISSUER_NAME = 'TWT AIRPACK SERVICOS AUX. DE TRANSP. AEREO LTDA';

const ENVIRONMENTS = Object.freeze({
  sandbox: Object.freeze({
    tokenUrl: 'https://openapisandbox.prebanco.com.br/auth/server-mtls/v2/token',
    registrationUrl: 'https://openapisandbox.prebanco.com.br/boleto/cobranca-registro/v1/cobranca',
    queryUrl: 'https://openapisandbox.prebanco.com.br/boleto/cobranca-consulta/v1/consultar'
  }),
  production: Object.freeze({
    tokenUrl: 'https://openapi.bradesco.com.br/auth/server-mtls/v2/token',
    registrationUrl: 'https://openapi.bradesco.com.br/boleto/cobranca-registro/v1/cobranca',
    queryUrl: 'https://openapi.bradesco.com.br/boleto/cobranca-consulta/v1/consultar'
  })
});

let cachedToken = '';
let cachedTokenExpiresAt = 0;
let cachedTokenConfigKey = '';

const configurationError = (message) =>
  Object.assign(new Error(message), { statusCode: 503, expose: true });

const digits = (value) => String(value || '').replace(/\D/g, '');

const decodeBase64Pem = (value, label, acceptedMarkers) => {
  const normalized = String(value || '').replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw configurationError(`${label} do Bradesco não configurado.`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  const pem = decoded.toString('utf8');
  if (!decoded.length || !acceptedMarkers.some((marker) => pem.includes(marker))) {
    throw configurationError(`${label} do Bradesco inválido.`);
  }
  return decoded;
};

const normalizedHttpsUrl = (value, fallback, label) => {
  let url;
  try {
    url = new URL(String(value || fallback).trim());
  } catch {
    throw configurationError(`${label} do Bradesco inválida.`);
  }
  if (url.protocol !== 'https:') {
    throw configurationError(`${label} do Bradesco deve utilizar HTTPS.`);
  }
  return url.toString();
};

const decimalSetting = (value, fallback, label) => {
  const text = String(value ?? fallback).trim().replace(',', '.');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) {
    throw configurationError(`${label} do Bradesco inválido.`);
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number >= 100) {
    throw configurationError(`${label} do Bradesco deve estar entre 0 e 99,99.`);
  }
  return number;
};

const bradescoConfig = (env = process.env) => {
  const environment = String(env.BRADESCO_ENVIRONMENT || 'sandbox').trim().toLowerCase();
  const target = ENVIRONMENTS[environment];
  if (!target) {
    throw configurationError('BRADESCO_ENVIRONMENT deve ser sandbox ou production.');
  }

  const clientId = String(env.BRADESCO_CLIENT_ID || '').trim();
  const clientSecret = String(env.BRADESCO_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw configurationError('Credenciais da API Bradesco não configuradas.');
  }

  const cert = decodeBase64Pem(
    env.BRADESCO_MTLS_CERT_BASE64,
    'Certificado mTLS',
    ['-----BEGIN CERTIFICATE-----']
  );
  const key = decodeBase64Pem(
    env.BRADESCO_MTLS_KEY_BASE64,
    'Chave privada mTLS',
    [
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----'
    ]
  );
  const passphrase = String(env.BRADESCO_MTLS_KEY_PASSPHRASE || '');

  const beneficiaryTaxId = digits(env.BRADESCO_BENEFICIARY_CNPJ || TWT_ISSUER_CNPJ);
  const agency = digits(env.BRADESCO_AGENCY);
  const account = digits(env.BRADESCO_ACCOUNT);
  const agencyDigit = String(env.BRADESCO_AGENCY_DIGIT || '').trim().toUpperCase();
  const accountDigit = String(env.BRADESCO_ACCOUNT_DIGIT || '').trim().toUpperCase();
  const productId = digits(env.BRADESCO_PRODUCT_ID || '09').padStart(2, '0');
  const species = digits(env.BRADESCO_BOLETO_SPECIES || '4');
  const acceptance = String(env.BRADESCO_BOLETO_ACCEPTANCE || '2').trim();
  const penaltyPercent = decimalSetting(
    env.BRADESCO_PENALTY_PERCENT,
    '3.00',
    'Percentual de multa'
  );
  const dailyInterestPercent = decimalSetting(
    env.BRADESCO_DAILY_INTEREST_PERCENT,
    '0.15',
    'Percentual diário de juros'
  );
  const monthlyInterestPercent = Number((dailyInterestPercent * 30).toFixed(2));
  const interestStartDays = digits(env.BRADESCO_INTEREST_START_DAYS || '2');
  const penaltyStartDays = digits(env.BRADESCO_PENALTY_START_DAYS || '2');

  if (beneficiaryTaxId.length !== 14) {
    throw configurationError('BRADESCO_BENEFICIARY_CNPJ deve conter 14 dígitos.');
  }
  if (agency.length !== 4) {
    throw configurationError('BRADESCO_AGENCY deve conter os 4 dígitos da agência, sem DV.');
  }
  if (account.length !== 7) {
    throw configurationError('BRADESCO_ACCOUNT deve conter os 7 dígitos da conta, sem DV.');
  }
  if (agencyDigit && !/^[0-9P]$/.test(agencyDigit)) {
    throw configurationError('BRADESCO_AGENCY_DIGIT deve conter um único dígito ou P.');
  }
  if (accountDigit && !/^[0-9P]$/.test(accountDigit)) {
    throw configurationError('BRADESCO_ACCOUNT_DIGIT deve conter um único dígito ou P.');
  }
  if (productId.length !== 2) {
    throw configurationError('BRADESCO_PRODUCT_ID deve conter 2 dígitos.');
  }
  if (!species || species.length > 2) {
    throw configurationError('BRADESCO_BOLETO_SPECIES deve conter 1 ou 2 dígitos.');
  }
  if (!['1', '2'].includes(acceptance)) {
    throw configurationError('BRADESCO_BOLETO_ACCEPTANCE deve ser 1 ou 2.');
  }
  if (monthlyInterestPercent >= 100) {
    throw configurationError('O percentual diário de juros gera percentual mensal inválido.');
  }
  if (!/^\d{1,2}$/.test(interestStartDays) || Number(interestStartDays) < 1) {
    throw configurationError('BRADESCO_INTEREST_START_DAYS deve conter de 1 a 2 dígitos.');
  }
  if (!/^\d{1,3}$/.test(penaltyStartDays) || Number(penaltyStartDays) < 1) {
    throw configurationError('BRADESCO_PENALTY_START_DAYS deve conter de 1 a 3 dígitos.');
  }

  const tokenUrl = normalizedHttpsUrl(env.BRADESCO_TOKEN_URL, target.tokenUrl, 'URL de autenticação');
  const registrationUrl = normalizedHttpsUrl(
    env.BRADESCO_REGISTRATION_URL,
    target.registrationUrl,
    'URL de registro'
  );
  const queryUrl = normalizedHttpsUrl(env.BRADESCO_QUERY_URL, target.queryUrl, 'URL de consulta');
  const tokenConfigKey = createHash('sha256')
    .update(`${environment}:${tokenUrl}:${clientId}:${clientSecret}:`)
    .update(cert)
    .update(key)
    .digest('hex');

  return {
    environment,
    clientId,
    clientSecret,
    cert,
    key,
    passphrase,
    tokenUrl,
    registrationUrl,
    queryUrl,
    tokenConfigKey,
    beneficiaryName: String(env.BRADESCO_BENEFICIARY_NAME || TWT_ISSUER_NAME).trim(),
    beneficiaryTaxId,
    beneficiaryRoot: beneficiaryTaxId.slice(0, 8),
    beneficiaryBranch: beneficiaryTaxId.slice(8, 12),
    beneficiaryControl: beneficiaryTaxId.slice(12),
    agency,
    agencyDigit,
    account,
    accountDigit,
    productId,
    species,
    acceptance,
    registrationNegotiation: `${agency}0000000${account}`,
    queryNegotiation: `${agency}${account}`,
    penaltyPercent,
    dailyInterestPercent,
    monthlyInterestPercent,
    interestStartDays,
    penaltyStartDays
  };
};

const cleanText = (value) => String(value ?? '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 300);

const validationIssue = (value, fieldHint = '') => {
  if (typeof value === 'string') return fieldHint ? `${fieldHint}: ${cleanText(value)}` : cleanText(value);
  if (!value || typeof value !== 'object') return '';
  const field = cleanText(value.campo || value.field || value.path || fieldHint);
  const message = cleanText(
    value.mensagem || value.message || value.descricao || value.description || value.tipoRestricao
  );
  return field && message ? `${field}: ${message}` : (message || field);
};

const bradescoIssues = (payload) => {
  const issues = [];
  for (const container of [payload, payload?.data, payload?.error].filter(Boolean)) {
    for (const key of ['errosValidacao', 'errors', 'erros', 'details', 'detalhes', 'lista']) {
      const values = container?.[key];
      if (Array.isArray(values)) {
        for (const value of values) {
          const issue = validationIssue(value);
          if (issue) issues.push(issue);
        }
      } else if (values && typeof values === 'object') {
        const direct = validationIssue(values);
        if (direct) issues.push(direct);
        else {
          for (const [field, value] of Object.entries(values)) {
            const issue = validationIssue(value, field);
            if (issue) issues.push(issue);
          }
        }
      }
    }
  }
  return [...new Set(issues)].slice(0, 5);
};

const safeUpstreamMessage = (payload, fallback) => {
  const general = [
    payload?.mensagem,
    payload?.message,
    payload?.causa,
    payload?.detail,
    payload?.error_description,
    typeof payload?.error === 'string' ? payload.error : ''
  ].map(cleanText).find(Boolean);
  const issues = bradescoIssues(payload);
  return cleanText([
    general || fallback,
    ...issues.filter((issue) => issue !== general)
  ].filter(Boolean).join(': '));
};

const httpsRequest = ({
  url,
  method = 'GET',
  headers = {},
  body = null,
  maxBytes = JSON_MAX_BYTES,
  config
}) => new Promise((resolve, reject) => {
  const payload = body === null || body === undefined
    ? null
    : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  const request = https.request(new URL(url), {
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
        request.destroy(Object.assign(new Error('Resposta do Bradesco excedeu o limite permitido.'), {
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
    request.destroy(Object.assign(new Error('Tempo esgotado ao acessar o Bradesco.'), {
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
    throw Object.assign(new Error('O Bradesco retornou uma resposta inválida.'), {
      statusCode: 502,
      receivedResponse: true,
      upstreamStatus: result.statusCode
    });
  }
};

const bradescoHttpError = (result, payload, fallback) => {
  const clientError = [400, 404, 412, 422].includes(result.statusCode);
  const permissionError = [401, 403].includes(result.statusCode);
  return Object.assign(new Error(safeUpstreamMessage(payload, fallback)), {
    statusCode: clientError ? 422 : (permissionError ? result.statusCode : 503),
    upstreamStatus: result.statusCode,
    receivedResponse: true,
    expose: clientError || permissionError,
    ...(bradescoIssues(payload).length ? { validationDetails: bradescoIssues(payload) } : {})
  });
};

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
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    config
  });
  const payload = jsonFromResponse(result);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw bradescoHttpError(result, payload, 'Falha de autenticação no Bradesco.');
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw Object.assign(new Error('O Bradesco não retornou um token de acesso.'), {
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
  url,
  method = 'POST',
  headers = {},
  body = null,
  config = bradescoConfig(),
  request = httpsRequest
}) => {
  const execute = async (forceRefresh = false) => {
    const token = await getAccessToken(config, forceRefresh, request);
    try {
      return await request({
        url,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...headers
        },
        body,
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

const barCodeFromDigitableLine = (value) => {
  const line = digits(value);
  if (line.length !== 47) return '';
  return `${line.slice(0, 4)}${line[32]}${line.slice(33)}${line.slice(4, 9)}${line.slice(10, 20)}${line.slice(21, 31)}`;
};

const dateOnly = (value) => {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = text.match(/^(\d{2})(\d{2})(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
};

const bradescoMoney = (value, decimalPlaces = 2) => {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  if (/[.,]/.test(text)) return Number(text.replace(',', '.'));
  if (!/^\d+$/.test(text)) return NaN;
  const places = Number.isInteger(Number(decimalPlaces)) ? Number(decimalPlaces) : 2;
  return Number(text) / (10 ** Math.max(0, Math.min(places, 6)));
};

const normalizeBradescoBankSlip = (payload, config = {}) => {
  const title = payload?.titulo || payload?.data?.titulo || payload?.data || payload;
  if (!title || typeof title !== 'object' || Array.isArray(title)) return null;

  const digitableLine = digits(title.linhaDigitavel || title.linhaDig);
  const explicitBarCode = digits(title.codigoBarras || title.barCode);
  const barCode = explicitBarCode.length === 44
    ? explicitBarCode
    : barCodeFromDigitableLine(digitableLine);
  const rawOurNumber = digits(title.nuTituloGerado || title.nossoNumero || title.nuTitulo);
  const ourNumber = rawOurNumber && rawOurNumber !== '0'
    ? rawOurNumber.padStart(11, '0')
    : '';
  const decimalPlaces = title.quantidadeCasas ?? title.qtdeCas ?? 2;
  const amount = bradescoMoney(
    title.vlTitulo ?? title.valorMoedaBol ?? title.valMoeda,
    decimalPlaces
  );
  const beneficiary = title.cedente || {};
  const payer = title.sacado || {};
  const responseBeneficiaryTaxId = digits(title['cpfcnpjBeneficiário'] || beneficiary.cnpj);

  return {
    id: ourNumber,
    registered: ourNumber.length === 11 && digitableLine.length === 47 && barCode.length === 44,
    ourNumber,
    yourNumber: String(title.seuNumeroTitulo || title.snumero || '').trim(),
    productId: digits(title.idProduto || config.productId).padStart(2, '0'),
    negotiation: digits(title.negociacao || config.registrationNegotiation),
    amount,
    dueDate: dateOnly(title.dtVencimentoBoleto || title.dataVenctoBol || title.dtVencimento || title.dataVencto),
    issuedAt: dateOnly(title.dtEmissao || title.dataEmis),
    digitableLine,
    barCode,
    wallet: digits(title.idProduto || config.productId).padStart(2, '0'),
    acceptance: String(title.aceite10 || title.aceite || '').trim(),
    speciesLabel: String(title.especieDocumentoTitulo || title.especDocto || 'DS').trim(),
    beneficiaryName: String(title.nomeBeneficiario || beneficiary.nome || config.beneficiaryName || '').trim(),
    beneficiaryTaxId: responseBeneficiaryTaxId.length === 14
      ? responseBeneficiaryTaxId
      : digits(config.beneficiaryTaxId),
    payerName: String(title.nomePagador || payer.nome || '').trim(),
    payerTaxId: digits(title.cpfcnpjPagador || payer.cnpj),
    status: String(title.status10 || title.status || payload?.mensagem || '').trim(),
    raw: payload
  };
};

const createBradescoBankSlip = async (payload, options = {}) => {
  const config = options.config || bradescoConfig();
  let result;
  try {
    result = await authenticatedRequest({
      url: config.registrationUrl,
      method: 'POST',
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
    if (
      (result.statusCode >= 200 && result.statusCode < 300) ||
      result.statusCode >= 500
    ) error.ambiguousBankState = true;
    throw error;
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const error = bradescoHttpError(result, response, 'O Bradesco recusou a emissão do boleto.');
    if (result.statusCode >= 500) error.ambiguousBankState = true;
    throw error;
  }

  const bankSlip = normalizeBradescoBankSlip(response, config);
  if (!bankSlip?.registered) {
    const error = Object.assign(new Error(
      'O Bradesco recebeu o registro, mas não retornou Nosso Número e linha digitável completos.'
    ), {
      statusCode: 502,
      receivedResponse: true,
      ambiguousBankState: true
    });
    if (bankSlip?.ourNumber) error.bankResponse = bankSlip;
    throw error;
  }
  return bankSlip;
};

const queryBradescoBankSlip = async (ourNumber, options = {}) => {
  const config = options.config || bradescoConfig();
  const normalizedOurNumber = digits(ourNumber);
  if (normalizedOurNumber.length !== 11) {
    throw configurationError('Nosso Número Bradesco deve conter 11 dígitos para consulta.');
  }
  const body = JSON.stringify({
    cpfCnpj: {
      cpfCnpj: config.beneficiaryRoot,
      filial: config.beneficiaryBranch,
      controle: config.beneficiaryControl
    },
    produto: config.productId,
    negociacao: config.queryNegotiation,
    nossoNumero: normalizedOurNumber,
    sequencia: '0',
    status: '0'
  });
  const result = await authenticatedRequest({
    url: config.queryUrl,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body,
    ...options,
    config
  });
  const response = jsonFromResponse(result);
  if (result.statusCode === 404) return null;
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw bradescoHttpError(result, response, 'Não foi possível consultar o boleto no Bradesco.');
  }
  const normalizedResponse = response?.titulo
    ? { ...response, titulo: { ...response.titulo, nossoNumero: normalizedOurNumber } }
    : { ...response, nossoNumero: normalizedOurNumber };
  const bankSlip = normalizeBradescoBankSlip(normalizedResponse, config);
  return bankSlip?.registered ? bankSlip : null;
};

const resetTokenCache = () => {
  cachedToken = '';
  cachedTokenExpiresAt = 0;
  cachedTokenConfigKey = '';
};

module.exports = {
  ENVIRONMENTS,
  REQUEST_TIMEOUT_MS,
  bradescoConfig,
  httpsRequest,
  jsonFromResponse,
  bradescoHttpError,
  requestAccessToken,
  authenticatedRequest,
  barCodeFromDigitableLine,
  dateOnly,
  bradescoMoney,
  normalizeBradescoBankSlip,
  createBradescoBankSlip,
  queryBradescoBankSlip,
  resetTokenCache
};
