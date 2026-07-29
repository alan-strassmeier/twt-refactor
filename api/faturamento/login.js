const {
  isConfigured,
  validCredentials,
  createSessionToken,
  sessionCookie
} = require('../../server/faturamento/auth');
const { registerAttempt, clearAttempts, MAX_ATTEMPTS } = require('../../server/faturamento/rate-limit');
const { sendJson, parseJsonBody, hasSameOrigin, clientAddress } = require('../../server/faturamento/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!hasSameOrigin(req)) {
    sendJson(res, 403, { message: 'Origem da solicitação inválida.' });
    return;
  }
  if (!isConfigured()) {
    sendJson(res, 503, { message: 'Área de faturamento ainda não configurada.' });
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const address = clientAddress(req);
    const attempts = await registerAttempt(address);
    if (attempts > MAX_ATTEMPTS) {
      res.setHeader('Retry-After', '900');
      sendJson(res, 429, { message: 'Muitas tentativas. Aguarde 15 minutos.' });
      return;
    }
    if (!validCredentials(username, password)) {
      sendJson(res, 401, { message: 'Usuário ou senha inválidos.' });
      return;
    }

    await clearAttempts(address);
    const secure = process.env.NODE_ENV === 'production' || String(req.headers['x-forwarded-proto']) === 'https';
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(username), secure));
    sendJson(res, 200, { authenticated: true, username });
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error instanceof SyntaxError ? 400 : 500);
    if (statusCode >= 500) console.error('[faturamento:login]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500 ? 'Não foi possível entrar agora.' : error.message
    });
  }
};
