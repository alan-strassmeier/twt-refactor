const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const { getIssuedNfseXml } = require('../../server/faturamento/nfse');

const safeNumber = (value) => String(value || '').replace(/\D/g, '').slice(0, 50);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para baixar o XML da NFS-e.' });
    return;
  }
  try {
    const { id } = queryFromRequest(req);
    const { record, xml } = await getIssuedNfseXml(id);
    const body = Buffer.from(xml, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="nfse-${safeNumber(record.accessKey || id)}.xml"`
    );
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502;
    if (statusCode >= 500) console.error('[faturamento:nfse-xml]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500 ? 'Não foi possível recuperar o XML da NFS-e.' : error.message
    });
  }
};
