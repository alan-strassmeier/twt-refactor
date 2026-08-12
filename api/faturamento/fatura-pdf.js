const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const {
  fetchInvoicePdfData,
  buildInvoicePdf
} = require('../../server/faturamento/invoice-pdf');

const safeFilenameNumber = (value) => String(value || '').replace(/\D/g, '').slice(0, 20);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para visualizar a fatura.' });
    return;
  }

  try {
    const { id } = queryFromRequest(req);
    const data = await fetchInvoicePdfData(id);
    const pdf = await buildInvoicePdf(data);
    const invoiceNumber = safeFilenameNumber(data.invoice.id || id);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="fatura-${invoiceNumber}.pdf"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.end(pdf);
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
    if (statusCode >= 500) console.error('[faturamento:fatura-pdf]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500
        ? 'Não foi possível gerar o PDF da fatura.'
        : error.message
    });
  }
};
