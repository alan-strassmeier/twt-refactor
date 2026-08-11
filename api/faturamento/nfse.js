const { sessionFromRequest } = require('../../server/faturamento/auth');
const {
  parseJsonBody,
  hasSameOrigin,
  queryFromRequest,
  sendJson
} = require('../../server/faturamento/http');
const {
  previewInvoiceNfse,
  getInvoiceNfseStatus,
  issueInvoiceNfse
} = require('../../server/faturamento/nfse');

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para acessar a NFS-e.' });
    return;
  }
  if (req.method === 'POST' && !hasSameOrigin(req)) {
    sendJson(res, 403, { message: 'Origem da solicitação inválida.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const { id, status } = queryFromRequest(req);
      sendJson(res, 200, status === '1'
        ? await getInvoiceNfseStatus(id)
        : await previewInvoiceNfse(id));
      return;
    }
    const body = await parseJsonBody(req, 1024);
    if (body.confirmed !== true) {
      sendJson(res, 422, { message: 'Confirme os dados fiscais antes de emitir a NFS-e.' });
      return;
    }
    const result = await issueInvoiceNfse(body.id);
    sendJson(res, result.created ? 201 : 200, result);
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
    if (statusCode >= 500) console.error('[faturamento:nfse]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500 && !error.expose
        ? 'Não foi possível concluir a emissão da NFS-e.'
        : error.message,
      ...(Array.isArray(error.upstreamMessages) ? { details: error.upstreamMessages } : {})
    });
  }
};
