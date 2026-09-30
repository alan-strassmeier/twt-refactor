const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const { resolveInvoiceCteKeys } = require('../../server/faturamento/cte-documents');
const {
  bankSlipBankForIssuer,
  isTwtIssuer,
  requiresTedDocForCategory
} = require('../../server/faturamento/billing-rules');
const billingStore = require('../../server/faturamento/cobranca-store');
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
    if (!documents.doccobFound) {
      sendJson(res, 200, {
        invoiceId: documents.invoiceId,
        doccobFound: false,
        hasCte: false,
        cteCount: 0,
        bankSlipEligible: false,
        bankSlipBank: null,
        bankSlipBankLabel: null,
        paymentMethod: null,
        nfseEligible: false,
        nfseStatus: 'not_issued',
        nfseNumber: null
      });
      return;
    }
    const bank = bankSlipBankForIssuer(documents.issuerCnpj);
    const category = documents.clientCnpj
      ? await billingStore.getCategory(documents.clientCnpj)
      : null;
    const tedDocPayment = requiresTedDocForCategory(category);
    const nfseEligible = isTwtIssuer(documents.issuerCnpj);
    let nfseRecord = null;
    let nfseCertificateMode = '';
    if (nfseEligible) {
      try {
        const fiscalConfig = nfseConfig(process.env, { requireCertificate: false });
        nfseCertificateMode = fiscalConfig.certificateMode;
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
      doccobFound: true,
      hasCte: documents.cteKeys.length > 0,
      cteCount: documents.cteKeys.length,
      bankSlipEligible: Boolean(bank) && !tedDocPayment,
      bankSlipBank: bank && !tedDocPayment ? bank.id : null,
      bankSlipBankLabel: bank && !tedDocPayment ? bank.label : null,
      paymentMethod: tedDocPayment ? 'ted_doc' : 'bank_slip',
      nfseEligible,
      nfseStatus: nfseRecord?.state || 'not_issued',
      nfseNumber: nfseRecord?.nfseNumber || null,
      nfseCertificateMode
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
