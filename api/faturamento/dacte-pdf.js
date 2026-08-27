const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const {
  resolveInvoiceCteKeys,
  fetchCteXmls
} = require('../../server/faturamento/cte-documents');
const { parseCteXml, buildDactePdf } = require('../../server/faturamento/dacte');

const safeFilenameNumber = (value) => String(value || '').replace(/\D/g, '').slice(0, 20);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para visualizar o DACTE.' });
    return;
  }

  try {
    const { id } = queryFromRequest(req);
    const documents = await resolveInvoiceCteKeys(id);
    if (!documents.cteKeys.length) {
      throw Object.assign(new Error('Esta fatura não possui CT-e vinculado.'), { statusCode: 404 });
    }
    const xmls = await fetchCteXmls(documents.cteKeys);
    const models = xmls.map(parseCteXml);
    const pdf = await buildDactePdf(models);
    const invoiceNumber = safeFilenameNumber(documents.invoiceId || id);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dactes-fatura-${invoiceNumber}.pdf"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.end(pdf);
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 502);
    if (statusCode >= 500) console.error('[faturamento:dacte-pdf]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500
        ? 'Não foi possível gerar o DACTE.'
        : error.message
    });
  }
};
