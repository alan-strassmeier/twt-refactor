const { randomUUID, timingSafeEqual } = require('node:crypto');
const { sessionFromRequest } = require('../../server/faturamento/auth');
const {
  parseJsonBody,
  hasSameOrigin,
  queryFromRequest,
  sendJson
} = require('../../server/faturamento/http');
const store = require('../../server/faturamento/cobranca-store');
const { runBillingCollection } = require('../../server/faturamento/cobranca-processor');

const constantTimeEqual = (left, right) => {
  const expected = Buffer.from(String(right || ''), 'utf8');
  const received = Buffer.from(String(left || ''), 'utf8');
  return expected.length > 0 && expected.length === received.length && timingSafeEqual(expected, received);
};

const hasCronAuthorization = (req, env = process.env) => {
  const secret = String(env.BILLING_CRON_SECRET || '');
  const authorization = String(req.headers.authorization || '');
  return secret.length >= 32 && constantTimeEqual(authorization, `Bearer ${secret}`);
};

const requireSession = (req, res) => {
  if (sessionFromRequest(req)) return true;
  sendJson(res, 401, { message: 'Faça login para acessar a cobrança de faturas.' });
  return false;
};

const requireSameOrigin = (req, res) => {
  if (hasSameOrigin(req)) return true;
  sendJson(res, 403, { message: 'Origem da solicitação inválida.' });
  return false;
};

const handleCategories = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method === 'GET') {
    const categories = await store.listCategories();
    sendJson(res, 200, {
      categories,
      totals: {
        categories: categories.length,
        contacts: categories.reduce((total, category) => total + category.contacts.length, 0)
      }
    });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  if (req.method === 'POST') {
    const category = await store.saveCategory(await parseJsonBody(req, 8192));
    sendJson(res, 200, { category });
    return;
  }
  if (req.method === 'DELETE') {
    const deleted = await store.deleteCategory(query.cnpj);
    sendJson(res, deleted ? 200 : 404, {
      deleted,
      message: deleted ? 'Empresa excluída.' : 'Empresa não encontrada.'
    });
    return;
  }
  res.setHeader('Allow', 'GET, POST, DELETE');
  sendJson(res, 405, { message: 'Método não permitido.' });
};

const handleContacts = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (!requireSameOrigin(req, res)) return;
  if (req.method === 'POST') {
    const body = await parseJsonBody(req, 8192);
    const result = await store.saveContact(body.cnpj, body);
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'DELETE') {
    const deleted = await store.deleteContact(query.cnpj, query.id);
    sendJson(res, deleted ? 200 : 404, {
      deleted,
      message: deleted ? 'Contato excluído.' : 'Contato não encontrado.'
    });
    return;
  }
  res.setHeader('Allow', 'POST, DELETE');
  sendJson(res, 405, { message: 'Método não permitido.' });
};

const handlePending = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const [pending, lastRun] = await Promise.all([
    store.listPending(),
    store.getLastRun()
  ]);
  sendJson(res, 200, {
    pending,
    lastRun,
    total: pending.length,
    doccobTotal: pending.filter((record) => record.reason === 'doccob').length
  });
};

const handleLogs = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const result = await store.listLogs({
    invoiceId: query.invoiceId,
    date: query.date,
    cnpj: query.cnpj,
    page: query.page,
    limit: query.limit
  });
  sendJson(res, 200, result);
};

const handleProcess = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const cron = hasCronAuthorization(req);
  if (!cron) {
    if (!requireSession(req, res) || !requireSameOrigin(req, res)) return;
  }
  const source = cron ? 'automatic' : 'manual';
  const runId = randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    sendJson(res, 409, {
      message: 'Já existe uma verificação de cobrança em andamento. Aguarde a conclusão.'
    });
    return;
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await runBillingCollection({ source, runId });
    const run = {
      runId,
      source,
      status: 'completed',
      startedAt,
      completedAt: result.completedAt,
      scanned: result.scanned,
      processed: result.processed,
      sent: result.sent,
      errors: result.errors.length
    };
    await store.saveLastRun(run);
    console.info('[faturamento:cobranca:execucao]', run);
    sendJson(res, 200, { ...result, runId, source });
  } catch (error) {
    const run = {
      runId,
      source,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      message: String(error.message || error).slice(0, 300)
    };
    try {
      await store.saveLastRun(run);
    } catch (storeError) {
      console.error('[faturamento:cobranca:registro-execucao]', storeError);
    }
    console.error('[faturamento:cobranca:execucao]', run);
    throw error;
  } finally {
    try {
      await store.releaseProcessingRun(runId);
    } catch (error) {
      console.error('[faturamento:cobranca:liberacao]', error);
    }
  }
};

module.exports = async (req, res) => {
  let query;
  try {
    query = queryFromRequest(req);
    if (query.route === 'categories') return await handleCategories(req, res, query);
    if (query.route === 'contacts') return await handleContacts(req, res, query);
    if (query.route === 'pending') return await handlePending(req, res);
    if (query.route === 'logs') return await handleLogs(req, res, query);
    if (query.route === 'process') return await handleProcess(req, res);
    sendJson(res, 404, { message: 'Rota de cobrança não encontrada.' });
  } catch (error) {
    const statusCode = Number(error.statusCode) || (error.name === 'AbortError' ? 504 : 500);
    if (statusCode >= 500) console.error('[faturamento:cobranca]', error);
    sendJson(res, statusCode, {
      message: statusCode >= 500 && !error.expose
        ? 'Não foi possível concluir a operação de cobrança.'
        : error.message
    });
  }
};

module.exports.constantTimeEqual = constantTimeEqual;
module.exports.hasCronAuthorization = hasCronAuthorization;
