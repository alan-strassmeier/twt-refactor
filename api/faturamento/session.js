const { isConfigured, sessionFromRequest } = require('../../server/faturamento/auth');
const { sendJson } = require('../../server/faturamento/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!isConfigured()) {
    sendJson(res, 503, {
      authenticated: false,
      message: 'Área de faturamento ainda não configurada.'
    });
    return;
  }
  const session = sessionFromRequest(req);
  sendJson(res, 200, {
    authenticated: Boolean(session),
    username: session?.sub || null
  });
};
