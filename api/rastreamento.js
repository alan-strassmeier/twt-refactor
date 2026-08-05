const { authorizedRequest } = require('../server/shared/brudam');
const {
  createHttpError,
  sendJson,
  parseJsonBody,
  clientAddress
} = require('../server/shared/http');
const { createFixedWindowLimiter } = require('../server/shared/rate-limit');

const MAX_REQUEST_SIZE = 2048;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const ALLOWED_DOCUMENT_TYPES = new Set(['nf', 'cte', 'minuta']);
const TAXPAYER_DOCUMENT_TYPES = new Set(['nf', 'cte']);

const rateLimiter = createFixedWindowLimiter({
  maximum: RATE_LIMIT_MAX_REQUESTS,
  durationMs: RATE_LIMIT_WINDOW_MS
});

const enforceRateLimit = (req, res) => {
  const address = clientAddress(req);
  if (!rateLimiter.consume(address)) {
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
  if (!ALLOWED_DOCUMENT_TYPES.has(type)) {
    throw createHttpError('Tipo de documento inválido.', 422);
  }

  if (!number || number.length > 60 || !/^[\p{L}\p{N}.\-/]+$/u.test(number)) {
    throw createHttpError('Número do documento inválido.', 422);
  }

  if (TAXPAYER_DOCUMENT_TYPES.has(type) && ![11, 14].includes(taxpayer.length)) {
    throw createHttpError('Informe um CPF ou CNPJ válido.', 422);
  }

  return { type, number, taxpayer };
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

const fetchTracking = (input) => authorizedRequest(trackingPath(input), {
  method: 'GET',
  headers: {
    Accept: 'application/json'
  }
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { status: 0, message: 'Método não permitido.' });
    return;
  }

  if (!enforceRateLimit(req, res)) return;

  try {
    const payload = await parseJsonBody(req, MAX_REQUEST_SIZE);
    const input = validateInput(payload);
    const { response, payload: brudamPayload } = await fetchTracking(input);

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

    if (statusCode >= 500) console.error('[tracking]', error);
    sendJson(res, statusCode, { status: 0, message: publicMessage });
  }
};
