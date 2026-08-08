const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const { resolveInvoiceCteKeys } = require('../../server/faturamento/cte-documents');
const { isTwtIssuer } = require('../../server/faturamento/billing-rules');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para visualizar os documentos.' });
    return;
  }

  try {
    const { id } = queryFromRequest(req);
    const documents = await resolveInvoiceCteKeys(id);
    sendJson(res, 200, {
      invoiceId: documents.invoiceId,
      hasCte: documents.cteKeys.length > 0,
      cteCount: documents.cteKeys.length,
      bankSlipEligible: isTwtIssuer(documents.issuerCnpj)
    });
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
    if (statusCode >= 500) console.error('[faturamento:documentos]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500
        ? 'Não foi possível conferir os documentos da fatura.'
        : error.message
    });
  }
};
