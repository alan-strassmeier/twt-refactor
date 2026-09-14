const { sessionFromRequest } = require('../../server/faturamento/auth');
const { fetchInvoices } = require('../../server/faturamento/brudam');
const { sendJson, queryFromRequest } = require('../../server/faturamento/http');
const {
  enrichInvoicesWithControl,
  invoiceControl
} = require('../../server/faturamento/invoice-control');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para consultar as faturas.' });
    return;
  }

  try {
    const result = await fetchInvoices(queryFromRequest(req));
    if (Array.isArray(result.invoices)) {
      try {
        result.invoices = await enrichInvoicesWithControl(result.invoices);
      } catch (error) {
        console.warn('[faturamento:controle-resumo]', { error: error.message });
        result.invoices = result.invoices.map((invoice) => ({
          ...invoice,
          control: invoiceControl(invoice)
        }));
        result.controlWarning = 'Os estados de cobrança e pagamento não puderam ser conferidos.';
      }
    }
    sendJson(res, 200, result);
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
    if (statusCode >= 500) console.error('[faturamento:faturas]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500
        ? 'Consulta de faturas temporariamente indisponível.'
        : error.message
    });
  }
};
