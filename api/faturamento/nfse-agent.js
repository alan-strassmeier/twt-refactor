const { parseJsonBody, sendJson } = require('../../server/faturamento/http');
const { nfseConfig } = require('../../server/faturamento/nfse-config');
const {
  authenticateNfseAgent,
  claimAgentJob,
  completeAgentJob
} = require('../../server/faturamento/nfse-agent');

module.exports = async (req, res) => {
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
