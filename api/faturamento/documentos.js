const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const { resolveInvoiceCteKeys } = require('../../server/faturamento/cte-documents');
const {
  bankSlipBankForIssuer,
  isTwtIssuer
} = require('../../server/faturamento/billing-rules');
const { getNfseRecord } = require('../../server/faturamento/nfse-store');

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
    const bank = bankSlipBankForIssuer(documents.issuerCnpj);
    const nfseEligible = isTwtIssuer(documents.issuerCnpj);
    let nfseRecord = null;
    if (nfseEligible) {
      try {
        nfseRecord = await getNfseRecord(documents.invoiceId);
      } catch (error) {
        console.warn('[faturamento:documentos-nfse]', {
          invoiceId: documents.invoiceId,
          error: error.message
        });
      }
    }
    sendJson(res, 200, {
      invoiceId: documents.invoiceId,
      hasCte: documents.cteKeys.length > 0,
      cteCount: documents.cteKeys.length,
      bankSlipEligible: Boolean(bank),
      bankSlipBank: bank?.id || null,
      bankSlipBankLabel: bank?.label || null,
      nfseEligible,
      nfseStatus: nfseRecord?.state || 'not_issued',
      nfseNumber: nfseRecord?.nfseNumber || null
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
