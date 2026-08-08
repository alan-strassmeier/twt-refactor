const { sessionFromRequest } = require('../../server/faturamento/auth');
const {
  parseJsonBody,
  hasSameOrigin,
  sendJson
} = require('../../server/faturamento/http');
const { generateInvoiceBankSlip } = require('../../server/faturamento/boleto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para gerar o boleto.' });
    return;
  }
  if (!hasSameOrigin(req)) {
    sendJson(res, 403, { message: 'Origem da solicitação inválida.' });
    return;
  }

  try {
    const body = await parseJsonBody(req, 1024);
    const result = await generateInvoiceBankSlip(body.id);
    sendJson(res, result.created ? 201 : 200, {
      ...result,
      pdfUrl: `/api/faturamento/boleto-pdf?id=${encodeURIComponent(result.invoiceId)}`
    });
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
    if (statusCode >= 500) console.error('[faturamento:boleto]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500
        ? (error.expose ? error.message : 'Não foi possível gerar o boleto no banco configurado.')
        : error.message
    });
  }
};
