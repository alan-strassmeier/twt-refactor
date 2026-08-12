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
  issueInvoiceNfse,
  getIssuedNfseXml
} = require('../../server/faturamento/nfse');
const { nfseConfig } = require('../../server/faturamento/nfse-config');
const {
  authenticateNfseAgent,
  claimAgentJob,
  completeAgentJob
} = require('../../server/faturamento/nfse-agent');
const { buildDanfsePdf } = require('../../server/faturamento/danfse');

const safeNumber = (value, maxLength = 20) => String(value || '')
  .replace(/\D/g, '')
  .slice(0, maxLength);

const handleIssuance = async (req, res) => {
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

const handleAgent = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }

  try {
    const agentConfig = authenticateNfseAgent(req);
    const fiscalConfig = nfseConfig(process.env, { requireCertificate: false });
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        certificateMode: fiscalConfig.certificateMode,
        environment: fiscalConfig.environment,
        serverTime: new Date().toISOString()
      });
      return;
    }

    const body = await parseJsonBody(req, 3 * 1024 * 1024);
    if (body.action === 'claim') {
      const job = await claimAgentJob({ agentId: body.agentId }, {
        config: fiscalConfig,
        agentConfig
      });
      sendJson(res, 200, { job });
      return;
    }
    if (body.action === 'complete') {
      const result = await completeAgentJob(body);
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 422, { message: 'Ação do agente inválida.' });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    if (statusCode >= 500) console.error('[faturamento:nfse-agent]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500 && !error.expose
        ? 'Falha interna na comunicação com o agente de NFS-e.'
        : error.message
    });
  }
};

const handlePdf = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!sessionFromRequest(req)) {
    sendJson(res, 401, { message: 'Faça login para visualizar a NFS-e.' });
    return;
  }
  try {
    const { id } = queryFromRequest(req);
    const { record, xml } = await getIssuedNfseXml(id);
    const pdf = await buildDanfsePdf(xml);
    const number = safeNumber(record.nfseNumber || id);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="danfse-${number}.pdf"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.end(pdf);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502;
    if (statusCode >= 500) console.error('[faturamento:nfse-pdf]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500 ? 'Não foi possível gerar o DANFSe.' : error.message
    });
  }
};

const handleXml = async (req, res) => {
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
      `attachment; filename="nfse-${safeNumber(record.accessKey || id, 50)}.xml"`
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

module.exports = async (req, res) => {
  let route;
  try {
    route = queryFromRequest(req).route || 'issuance';
  } catch (error) {
    sendJson(res, Number(error.statusCode) || 400, { message: error.message });
    return;
  }

  if (route === 'issuance') return handleIssuance(req, res);
  if (route === 'agent') return handleAgent(req, res);
  if (route === 'pdf') return handlePdf(req, res);
  if (route === 'xml') return handleXml(req, res);
  sendJson(res, 404, { message: 'Rota de NFS-e não encontrada.' });
};
