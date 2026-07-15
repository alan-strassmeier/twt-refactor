const BRUDAM_API_URL = (process.env.BRUDAM_API_URL || 'https://twt.brudam.com.br/api/v1').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 15000;
const MAX_REQUEST_SIZE = 2048;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 30;

let cachedToken = '';
let cachedTokenExpiresAt = 0;
const rateLimitStore = new Map();

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(payload));
};

const parseJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_SIZE) {
      const error = new Error('Requisição muito grande.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const clientAddress = (req) => {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '');
  return forwardedFor.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
};

const enforceRateLimit = (req, res) => {
  const now = Date.now();
  const address = clientAddress(req);
  const current = rateLimitStore.get(address);

  if (!current || current.expiresAt <= now) {
    rateLimitStore.set(address, { count: 1, expiresAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  current.count += 1;
  if (current.count > RATE_LIMIT_MAX_REQUESTS) {
    res.setHeader('Retry-After', '60');
    sendJson(res, 429, { status: 0, message: 'Muitas consultas. Aguarde um minuto.' });
    return false;
  }

  return true;
};

const validateInput = (payload) => {
  const type = String(payload.type || '').trim().toLowerCase();
  const number = String(payload.number || '').trim();
  const taxpayer = String(payload.taxpayer || '').replace(/\D/g, '');
  const allowedTypes = new Set(['nf', 'cte', 'minuta']);

  if (!allowedTypes.has(type)) {
    const error = new Error('Tipo de documento inválido.');
    error.statusCode = 422;
    throw error;
  }

  if (!number || number.length > 60 || !/^[\p{L}\p{N}.\-/]+$/u.test(number)) {
    const error = new Error('Número do documento inválido.');
    error.statusCode = 422;
    throw error;
  }

  if ((type === 'nf' || type === 'cte') && ![11, 14].includes(taxpayer.length)) {
    const error = new Error('Informe um CPF ou CNPJ válido.');
    error.statusCode = 422;
    throw error;
  }

  return { type, number, taxpayer };
};

const brudamRequest = async (path, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BRUDAM_API_URL}${path}`, {
      ...options,
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { status: 0, message: 'Resposta inválida da Brudam.' };

    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
};

const tokenExpiration = (token) => {
  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - encodedPayload.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(encodedPayload + padding, 'base64').toString('utf8'));
    return Number(payload.exp) * 1000;
  } catch {
    return Date.now() + 240000;
  }
};

const getAccessToken = async (forceRefresh = false) => {
  if (!forceRefresh && cachedToken && Date.now() < cachedTokenExpiresAt - 30000) {
    return cachedToken;
  }

  const usuario = process.env.BRUDAM_API_USER || '';
  const senha = process.env.BRUDAM_API_PASSWORD || '';

  if (!/^[A-Fa-f0-9]{32}$/.test(usuario) || !/^[A-Fa-f0-9]{64}$/.test(senha)) {
    const error = new Error('Integração de rastreamento não configurada.');
    error.statusCode = 503;
    throw error;
  }

  const { response, payload } = await brudamRequest('/acesso/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ usuario, senha })
  });
  const token = payload?.data?.access_key;

  if (!response.ok || typeof token !== 'string' || token === '') {
    const error = new Error(payload?.message || 'Não foi possível autenticar na Brudam.');
    error.statusCode = 502;
    throw error;
  }

  cachedToken = token;
  cachedTokenExpiresAt = tokenExpiration(token);
  return cachedToken;
};

const trackingPath = ({ type, taxpayer, number }) => {
  const routes = {
    nf: ['/tracking/ocorrencias/cnpj/nf', { documento: taxpayer, numero: number }],
    cte: ['/tracking/ocorrencias/cnpj/cte', { documento: taxpayer, numero: number }],
    minuta: ['/tracking/ocorrencias/minuta', { codigo: number }]
  };
  const [path, query] = routes[type];
  return `${path}?${new URLSearchParams(query)}`;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { status: 0, message: 'Método não permitido.' });
    return;
  }

  if (!enforceRateLimit(req, res)) return;

  try {
    const payload = await parseJsonBody(req);
    const input = validateInput(payload);
    let token = await getAccessToken();
    let { response, payload: brudamPayload } = await brudamRequest(trackingPath(input), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 401) {
      cachedToken = '';
      cachedTokenExpiresAt = 0;
      token = await getAccessToken(true);
      ({ response, payload: brudamPayload } = await brudamRequest(trackingPath(input), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        }
      }));
    }

    const statusCode = response.ok ? 200 : response.status;
    sendJson(res, statusCode, brudamPayload);
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { status: 0, message: 'Requisição inválida.' });
      return;
    }

    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
    const publicMessage = statusCode >= 500 && statusCode !== 503
      ? 'Rastreamento temporariamente indisponível.'
      : error.message;

    console.error('[tracking]', error);
    sendJson(res, statusCode, { status: 0, message: publicMessage });
  }
};
