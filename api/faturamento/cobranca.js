const { randomUUID, timingSafeEqual } = require('node:crypto');
const { sessionFromRequest } = require('../../server/faturamento/auth');
const {
  parseJsonBody,
  hasSameOrigin,
  queryFromRequest,
  sendJson
} = require('../../server/faturamento/http');
const store = require('../../server/faturamento/cobranca-store');
const brudamContacts = require('../../server/faturamento/cobranca-brudam-contacts');
const { runBillingCollection } = require('../../server/faturamento/cobranca-processor');
const { fetchInvoices } = require('../../server/faturamento/brudam');
const { findDoccobForInvoice } = require('../../server/faturamento/r2-doccob');
const { getBankSlipRecord } = require('../../server/faturamento/boleto-store');
const { isDslIssuer } = require('../../server/faturamento/billing-rules');
const {
  invoiceControl,
  buildUnifiedIssues,
  issueSummary,
  buildInvoiceTimeline
} = require('../../server/faturamento/invoice-control');
const {
  readWebhookBody,
  webhookConfig,
  webhookTokenAuthorized,
  parseWebhookPayload,
  validateWebhook,
  processWebhookPayload
} = require('../../server/faturamento/cobranca-webhook');

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
        contacts: categories.reduce((total, category) => total + category.contacts.filter(
          (contact) => contact.enabled !== false
        ).length, 0),
        registeredContacts: categories.reduce((total, category) => total + category.contacts.length, 0)
      }
    });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  if (req.method === 'POST') {
    const result = await brudamContacts.registerCompany(await parseJsonBody(req, 8192));
    sendJson(res, 200, {
      ...result,
      message: result.imported
        ? `Empresa salva e ${result.imported} contato(s) importado(s) da Brudam.`
        : 'Empresa salva. Nenhum contato novo foi encontrado na Brudam.'
    });
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
  if (req.method === 'PATCH') {
    const body = await parseJsonBody(req, 8192);
    const result = await store.setContactEnabled(body.cnpj, body.id, body.enabled);
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'DELETE') {
    const result = await brudamContacts.deleteContact(query.cnpj, query.id);
    sendJson(res, result.deleted ? 200 : 404, {
      ...result,
      message: result.deleted
        ? result.remoteRemoved
          ? 'Contato excluído deste sistema e da Brudam.'
          : 'Contato excluído. Ele não estava cadastrado na Brudam.'
        : 'Contato não encontrado.'
    });
    return;
  }
  res.setHeader('Allow', 'POST, PATCH, DELETE');
  sendJson(res, 405, { message: 'Método não permitido.' });
};

const handleContactSync = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const body = await parseJsonBody(req, 8192);
  const result = await brudamContacts.syncCompanyContacts(body.cnpj);
  sendJson(res, 200, {
    ...result,
    message: result.imported
      ? `${result.imported} contato(s) novo(s) importado(s) da Brudam.`
      : 'Os contatos já estão atualizados.'
  });
};

const handlePending = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const [pending, logs, lastRun] = await Promise.all([
    store.listPending(),
    store.filteredLogs(),
    store.getLastRun()
  ]);
  const issues = buildUnifiedIssues({ pending, logs });
  sendJson(res, 200, {
    pending,
    issues,
    lastRun,
    total: issues.length,
    doccobTotal: issues.filter((issue) => (
      issue.type === 'documents' && issue.title === 'Aguardando DOCCOB'
    )).length,
    summary: issueSummary(issues)
  });
};

const handleInvoiceDetail = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const rawInvoiceId = String(query.id || '').trim();
  if (!/^\d{1,20}$/.test(rawInvoiceId) || Number(rawInvoiceId) <= 0) {
    sendJson(res, 422, { message: 'Informe o número da fatura.' });
    return;
  }
  const invoiceId = rawInvoiceId.replace(/^0+(?=\d)/, '');
  const result = await fetchInvoices({ id: invoiceId, limit: 1 });
  const invoice = result.invoices?.find((item) => String(item.id) === invoiceId);
  if (!invoice) {
    sendJson(res, 404, { message: 'Fatura não encontrada na Brudam.' });
    return;
  }
  const [pendingRecords, logs, bankRecord] = await Promise.all([
    store.listPending(),
    store.filteredLogs({ invoiceId }),
    getBankSlipRecord(invoiceId)
  ]);
  const pending = pendingRecords.find((record) => String(record.invoiceId) === invoiceId) || null;
  let doccob = null;
  let doccobError = '';
  try {
    doccob = await findDoccobForInvoice({
      invoiceId,
      clientCnpj: invoice.clientDocument
    });
  } catch (error) {
    doccobError = error.message;
  }
  const cteCount = (Array.isArray(doccob?.transports) ? doccob.transports : [])
    .filter((transport) => transport?.accessKey).length;
  const controls = invoiceControl(invoice, { pending, logs, bankRecord });
  if (doccob && isDslIssuer(doccob.invoice?.issuerCnpj) && cteCount === 0) {
    controls.documents = {
      code: 'dacte_unavailable',
      label: 'DACTE indisponível',
      tone: 'danger',
      detail: 'O DOCCOB foi localizado, mas não contém chave CT-e para gerar o DACTE.'
    };
  } else if (doccob && controls.documents.code !== 'dacte_unavailable') {
    controls.documents = {
      code: 'complete',
      label: 'Documentos prontos',
      tone: 'success',
      detail: cteCount
        ? `DOCCOB localizado com ${cteCount} CT-e${cteCount === 1 ? '' : 's'}.`
        : 'DOCCOB localizado; esta fatura não possui CT-e.'
    };
  } else if (!doccob && controls.documents.code === 'unchecked') {
    controls.documents = {
      code: 'awaiting_doccob',
      label: 'DOCCOB não localizado',
      tone: 'warning',
      ...(doccobError ? { detail: doccobError } : {})
    };
  }
  sendJson(res, 200, {
    invoice,
    controls,
    documents: {
      doccobFound: Boolean(doccob),
      cteCount,
      objectKey: doccob?.objectKey || ''
    },
    payment: bankRecord ? {
      state: bankRecord.state || '',
      bank: bankRecord.bank || '',
      bankSlipId: bankRecord.bankSlipId || '',
      createdAt: bankRecord.createdAt || bankRecord.startedAt || bankRecord.reviewedAt || ''
    } : null,
    pending,
    timeline: buildInvoiceTimeline({ invoice, pending, logs, bankRecord })
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

const handleWebhook = async (req, res) => {
  const config = webhookConfig();
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ready' }));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const body = await readWebhookBody(req);
  const payload = webhookTokenAuthorized(req.headers, config)
    ? parseWebhookPayload(body)
    : validateWebhook({
      body,
      signatureHeader: req.headers['producer-signature'],
      config
    });
  const result = await processWebhookPayload(payload);
  sendJson(res, 200, { received: true, ...result });
};

module.exports = async (req, res) => {
  let query;
  try {
    query = queryFromRequest(req);
    if (query.route === 'categories') return await handleCategories(req, res, query);
    if (query.route === 'contacts') return await handleContacts(req, res, query);
    if (query.route === 'contacts-sync') return await handleContactSync(req, res);
    if (query.route === 'pending') return await handlePending(req, res);
    if (query.route === 'invoice-detail') return await handleInvoiceDetail(req, res, query);
    if (query.route === 'logs') return await handleLogs(req, res, query);
    if (query.route === 'process') return await handleProcess(req, res);
    if (query.route === 'webhook') return await handleWebhook(req, res);
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
