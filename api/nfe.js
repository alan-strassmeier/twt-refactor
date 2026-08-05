const {
  authenticateCredentials,
  createSessionToken,
  sessionFromRequest,
  sessionCookie,
  expiredSessionCookie
} = require('../server/nfe/auth');
const { isValidAccessKey } = require('../server/nfe/xml');
const {
  createHttpError,
  sendJson,
  parseJsonBody,
  clientAddress,
  hasSameOrigin
} = require('../server/shared/http');
const { createFixedWindowLimiter } = require('../server/shared/rate-limit');

const MAX_REQUEST_SIZE = 64_000;
const MAX_BATCH_ITEMS = 10;
const loginLimiter = createFixedWindowLimiter({
  maximum: 5,
  durationMs: 10 * 60 * 1000
});
const processLimiter = createFixedWindowLimiter({
  maximum: 10,
  durationMs: 60 * 1000
});
const MINUTA_UPDATE_UNAVAILABLE =
  'A atualização de uma minuta existente ainda não está disponível na API pública da Brudam. Nenhuma minuta foi criada ou alterada.';

const requireSession = (req) => {
  if (!sessionFromRequest(req)) throw createHttpError('Sua sessão expirou. Entre novamente.', 401);
};

const actionFromRequest = (req) => String(req.query?.action || '').toLowerCase();

const login = async (req, res) => {
  const address = clientAddress(req);
  if (!loginLimiter.consume(address)) {
    res.setHeader('Retry-After', '600');
    throw createHttpError('Muitas tentativas. Aguarde 10 minutos.', 429);
  }
  const body = await parseJsonBody(req, MAX_REQUEST_SIZE);
  if (!authenticateCredentials(String(body.user || ''), String(body.password || ''))) {
    throw createHttpError('Usuário ou senha incorretos.', 401);
  }
  loginLimiter.clear(address);
  res.setHeader('Set-Cookie', sessionCookie(req, createSessionToken()));
  sendJson(res, 200, {
    status: 1,
    user: 'twt',
    processingAvailable: false
  });
};

const session = (req, res) => {
  sendJson(res, 200, {
    status: 1,
    authenticated: sessionFromRequest(req),
    processingAvailable: false
  });
};

const logout = (req, res) => {
  res.setHeader('Set-Cookie', expiredSessionCookie(req));
  sendJson(res, 200, { status: 1 });
};

const validateBatch = (body) => {
  const minuta = String(body.minuta || '').replace(/\D/g, '');
  const keys = [...new Set((Array.isArray(body.keys) ? body.keys : [])
    .map((key) => String(key).replace(/\D/g, ''))
    .filter(Boolean))];
  if (!/^[1-9]\d{0,9}$/.test(minuta)) {
    throw createHttpError('Informe o número da minuta existente na Brudam.', 422);
  }
  if (keys.some((key) => !isValidAccessKey(key))) {
    throw createHttpError('Uma ou mais chaves de acesso são inválidas.', 422);
  }
  if (!keys.length) throw createHttpError('Informe ao menos uma NF-e.', 422);
  if (keys.length > MAX_BATCH_ITEMS) {
    throw createHttpError(`Envie no máximo ${MAX_BATCH_ITEMS} NF-es por lote.`, 422);
  }
  return { keys, minuta };
};

const processBatch = async (req, res) => {
  requireSession(req);
  const address = clientAddress(req);
  if (!processLimiter.consume(address)) {
    res.setHeader('Retry-After', '60');
    throw createHttpError('Muitos lotes enviados. Aguarde um minuto.', 429);
  }

  validateBatch(await parseJsonBody(req, MAX_REQUEST_SIZE));
  throw createHttpError(MINUTA_UPDATE_UNAVAILABLE, 503);
};

module.exports = async (req, res) => {
  const action = actionFromRequest(req);
  try {
    if (req.method === 'GET' && action === 'session') {
      session(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      throw createHttpError('Método não permitido.', 405);
    }
    if (!hasSameOrigin(req)) throw createHttpError('Origem da requisição inválida.', 403);
    if (action === 'login') await login(req, res);
    else if (action === 'logout') {
      requireSession(req);
      logout(req, res);
    } else if (action === 'process') {
      await processBatch(req, res);
    } else {
      throw createHttpError('Ação inválida.', 404);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { status: 0, message: 'Requisição inválida.' });
      return;
    }
    const statusCode = Number(error.statusCode) ||
      (error.name === 'AbortError' || error.name === 'TimeoutError' ? 504 : 500);
    if (statusCode >= 500 && statusCode !== 503) console.error('[nfe:api]', error);
    sendJson(res, statusCode, {
      status: 0,
      message: statusCode >= 500 && statusCode !== 503
        ? 'Serviço temporariamente indisponível.'
        : error.message
    });
  }
};
