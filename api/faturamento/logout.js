const { clearSessionCookie } = require('../../server/faturamento/auth');
const { sendJson, hasSameOrigin } = require('../../server/faturamento/http');

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
  const secure = process.env.NODE_ENV === 'production' || String(req.headers['x-forwarded-proto']) === 'https';
  res.setHeader('Set-Cookie', clearSessionCookie(secure));
  sendJson(res, 200, { authenticated: false });
};
