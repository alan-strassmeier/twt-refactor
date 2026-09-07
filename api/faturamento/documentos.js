const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const { resolveInvoiceCteKeys } = require('../../server/faturamento/cte-documents');
const {
  bankSlipBankForIssuer,
  isTwtIssuer,
  requiresTedDocPayment
} = require('../../server/faturamento/billing-rules');
const { fetchCompany } = require('../../server/faturamento/invoice-pdf');
const { getNfseRecord } = require('../../server/faturamento/nfse-store');
const { nfseConfig } = require('../../server/faturamento/nfse-config');

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
    let company = null;
    if (bank && documents.clientCnpj) {
      try {
        company = await fetchCompany(documents.clientCnpj);
      } catch (error) {
        console.warn('[faturamento:documentos-cliente]', {
          invoiceId: documents.invoiceId,
          clientCnpj: documents.clientCnpj,
          error: error.message
        });
      }
    }
    const tedDocPayment = requiresTedDocPayment({
      clientNames: [
        documents.clientName,
        company?.fantasia,
        company?.xFant,
        company?.razao,
        company?.razao_social,
        company?.nome,
        company?.xNome
      ],
      clientDocument: documents.clientCnpj,
      paymentMethod: documents.paymentMethod
    });
    const nfseEligible = isTwtIssuer(documents.issuerCnpj);
    let nfseRecord = null;
    if (nfseEligible) {
      try {
        const fiscalConfig = nfseConfig(process.env, { requireCertificate: false });
        nfseRecord = await getNfseRecord(documents.invoiceId, fiscalConfig.environment);
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
      bankSlipEligible: Boolean(bank) && !tedDocPayment,
      bankSlipBank: bank && !tedDocPayment ? bank.id : null,
      bankSlipBankLabel: bank && !tedDocPayment ? bank.label : null,
      paymentMethod: tedDocPayment ? 'ted_doc' : 'bank_slip',
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
