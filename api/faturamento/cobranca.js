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
const {
  runBillingCollection,
  resendBillingInvoice,
  refreshBillingPending,
  enrichLegacyReviewLogs
} = require('../../server/faturamento/cobranca-processor');
const { fetchInvoices } = require('../../server/faturamento/brudam');
const { findDoccobForInvoice } = require('../../server/faturamento/r2-doccob');
const { getBankSlipRecord } = require('../../server/faturamento/boleto-store');
const {
  previewJointBilling, refreshJointBillingInvoice, sendJointBilling
} = require('../../server/faturamento/cobranca-conjunta');
const { listLiquidationLog } = require('../../server/faturamento/liquidation-log');
const {
  analyzePaymentImport,
  approvePaymentImport
} = require('../../server/faturamento/payment-import');
const {
  runBankQueryDiagnostic,
  diagnoseItauDetailQuery,
  saoPauloDate
} = require('../../server/faturamento/bank-query-diagnostic');
const {
  previewItauReconciliation,
  reconcileItauInvoice,
  rearmItauReconciliation,
  previewBankReconciliation,
  reconcileBankInvoice,
  reconcileBankPayments
} = require('../../server/faturamento/bank-payment-reconciliation');
const {
  getInactiveSnapshot,
  getInactiveRefresh,
  startInactiveRefresh,
  continueInactiveRefresh
} = require('../../server/faturamento/inactive-clients');
const {
  BANK_SLIP_CREATION_START_DATE,
  isDslIssuer,
  isBankSlipCreationEligible
} = require('../../server/faturamento/billing-rules');
const {
  invoiceControl,
  buildUnifiedIssues,
  issueSummary,
  buildInvoiceTimeline,
  billingWhatsappText
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

const handleInactiveClients = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method === 'GET') {
    const [snapshot, refresh] = await Promise.all([
      getInactiveSnapshot(), getInactiveRefresh()
    ]);
    sendJson(res, 200, { snapshot, refresh });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 512);
  if (body.action === 'start') {
    sendJson(res, 200, { complete: false, refresh: await startInactiveRefresh() });
    return;
  }
  if (body.action === 'continue') {
    sendJson(res, 200, await continueInactiveRefresh({ runId: body.runId }));
    return;
  }
  sendJson(res, 422, { message: 'Ação de atualização inválida.' });
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
  if (req.method === 'PATCH') {
    const category = await store.saveCategory(await parseJsonBody(req, 8192));
    sendJson(res, 200, {
      category,
      message: 'Dados da empresa atualizados.'
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
  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
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
  if (req.method === 'DELETE') {
    if (!requireSameOrigin(req, res)) return;
    const body = await parseJsonBody(req, 4096);
    const [pending, logs, categories] = await Promise.all([
      store.listPending(),
      store.filteredLogs(),
      store.listCategories()
    ]);
    const activeContactCnpjs = categories
      .filter((category) => category.contacts.some((contact) => contact.enabled !== false))
      .map((category) => category.cnpj);
    const issue = buildUnifiedIssues({ pending, logs, activeContactCnpjs })
      .find((record) => record.id === body.id);
    if (!issue) {
      sendJson(res, 404, {
        deleted: false,
        message: 'Pendência não encontrada ou já removida.'
      });
      return;
    }
    await store.dismissIssue(issue.id, issue.updatedAt);
    sendJson(res, 200, {
      deleted: true,
      message: 'Pendência removida da lista. Os logs foram preservados.'
    });
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, DELETE');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const [pending, logs, lastRun, dismissedIssues, categories] = await Promise.all([
    store.listPending(),
    store.filteredLogs(),
    store.getLastRun(),
    store.listDismissedIssues(),
    store.listCategories()
  ]);
  const activeContactCnpjs = categories
    .filter((category) => category.contacts.some((contact) => contact.enabled !== false))
    .map((category) => category.cnpj);
  const issues = buildUnifiedIssues({ pending, logs, activeContactCnpjs }).filter((issue) => (
    dismissedIssues.get(issue.id) !== String(issue.updatedAt || '')
  ));
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

const handlePendingRefresh = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const body = await parseJsonBody(req, 4096);
  const runId = randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    sendJson(res, 409, {
      message: 'Já existe uma operação de cobrança em andamento. Aguarde a conclusão.'
    });
    return;
  }
  try {
    const [pending, logs, dismissedIssues, categories] = await Promise.all([
      store.listPending(),
      store.filteredLogs(),
      store.listDismissedIssues(),
      store.listCategories()
    ]);
    const activeContactCnpjs = categories
      .filter((category) => category.contacts.some((contact) => contact.enabled !== false))
      .map((category) => category.cnpj);
    const issues = buildUnifiedIssues({ pending, logs, activeContactCnpjs }).filter((issue) => (
      dismissedIssues.get(issue.id) !== String(issue.updatedAt || '')
    ));
    const result = await refreshBillingPending({
      source: 'manual',
      runId,
      after: body.after,
      issueRecords: issues
    });
    const settledIds = new Set(result.settledInvoiceIds || []);
    await Promise.all(issues
      .filter((issue) => settledIds.has(String(issue.invoiceId)))
      .map((issue) => store.dismissIssue(issue.id, issue.updatedAt)));
    sendJson(res, 200, {
      ...result,
      message: `${result.processed} pendência(s) conferida(s), ${result.settledInvoices} liquidada(s) removida(s) e ${result.resolved} solucionada(s).`
    });
  } finally {
    try {
      await store.releaseProcessingRun(runId);
    } catch (error) {
      console.error('[faturamento:cobranca:liberacao-pendencias]', error);
    }
  }
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
  const result = await fetchInvoices({ id: invoiceId, limit: 100 });
  const invoice = result.invoices?.find((item) => String(item.id) === invoiceId);
  if (!invoice) {
    sendJson(res, 404, { message: 'Fatura não encontrada na Brudam.' });
    return;
  }
  const clientCnpj = String(invoice.clientDocument || '').replace(/\D/g, '');
  const [pendingRecords, logs, bankRecord, category, invoiceBlock] = await Promise.all([
    store.listPending(),
    store.filteredLogs({ invoiceId }),
    getBankSlipRecord(invoiceId),
    clientCnpj.length === 14 ? store.getCategory(clientCnpj) : Promise.resolve(null),
    store.getInvoiceBlock(invoiceId)
  ]);
  const pending = pendingRecords.find((record) => String(record.invoiceId) === invoiceId) || null;
  let doccob = null;
  let doccobError = '';
  try {
    doccob = await findDoccobForInvoice({
      invoiceId,
      clientCnpj: invoice.clientDocument,
      issuedAt: invoice.issuedAt
    });
  } catch (error) {
    doccobError = error.message;
  }
  const cteCount = (Array.isArray(doccob?.transports) ? doccob.transports : [])
    .filter((transport) => transport?.accessKey).length;
  const controls = invoiceControl(invoice, { pending, logs, bankRecord, category });
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
  const blocked = Boolean(invoiceBlock?.blocked);
  if (blocked) {
    controls.collection = {
      code: 'blocked',
      label: 'Envio bloqueado',
      tone: 'danger',
      detail: 'Esta fatura não será enviada pelo processamento automático nem pelo reenvio manual.'
    };
  }
  const bankSlipBeforeCreationStart = !isBankSlipCreationEligible({
    issuedAt: doccob?.invoice?.issuedAt || invoice.issuedAt
  }) && !['ted_doc', 'registered'].includes(controls.payment.code);
  const resendBlockedReason = blocked
    ? 'O envio desta fatura está bloqueado manualmente.'
    : bankSlipBeforeCreationStart
    ? `Novos boletos não podem ser gerados para faturas emitidas antes de ${BANK_SLIP_CREATION_START_DATE.split('-').reverse().join('/')}. O reenvio é permitido quando já existe boleto registrado ou o pagamento é TED/DOC.`
    : ['paid', 'cancelled'].includes(controls.financial.code)
    ? 'Somente faturas em aberto podem ser reenviadas.'
    : !doccob
      ? 'Aguarde o DOCCOB antes de reenviar a cobrança.'
      : !category?.contacts?.some((contact) => contact.enabled !== false)
        ? 'Cadastre ao menos um destinatário ativo para reenviar.'
        : '';
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
    collectionBlock: invoiceBlock,
    actions: {
      canResend: !resendBlockedReason,
      resendBlockedReason,
      blocked,
      whatsappMessage: billingWhatsappText(invoice)
    },
    timeline: buildInvoiceTimeline({ invoice, pending, logs, bankRecord })
  });
};

const handleLogs = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method === 'GET') {
    const result = await store.listLogs({
      invoiceId: query.invoiceId,
      date: query.date,
      cnpj: query.cnpj,
      page: query.page,
      limit: query.limit
    });
    result.logs = await enrichLegacyReviewLogs(result.logs);
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'PATCH') {
    if (!requireSameOrigin(req, res)) return;
    const body = await parseJsonBody(req, 4096);
    const log = await store.resolveLog(body.id, body.note);
    sendJson(res, log ? 200 : 404, {
      log,
      message: log
        ? 'Ocorrência marcada como resolvida.'
        : 'Registro de log não encontrado.'
    });
    return;
  }
  res.setHeader('Allow', 'GET, PATCH');
  sendJson(res, 405, { message: 'Método não permitido.' });
};

const handleInvoiceBlock = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const body = await parseJsonBody(req, 4096);
  const result = await store.setInvoiceBlocked(body.invoiceId, body.blocked);
  const remainingBlock = result.blocked ? result : await store.getInvoiceBlock(result.invoiceId);
  sendJson(res, 200, {
    ...result,
    blocked: Boolean(remainingBlock?.blocked),
    message: result.blocked
      ? `Envio da fatura ${result.invoiceId} bloqueado.`
      : remainingBlock?.reason === 'bank_reconciliation'
        ? `Bloqueio manual removido, mas a fatura ${result.invoiceId} continua bloqueada para cobrança por pendência bancária.`
      : `Envio da fatura ${result.invoiceId} liberado.`
  });
};

const handlePaymentImport = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method === 'GET') {
    const record = await store.getPaymentImport(query.id);
    sendJson(res, record ? 200 : 404, {
      import: record,
      message: record ? undefined : 'A importação expirou ou não foi encontrada.'
    });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  if (req.method === 'POST') {
    const body = await parseJsonBody(req, 3 * 1024 * 1024);
    const record = await analyzePaymentImport(body);
    sendJson(res, 200, {
      import: record,
      message: `${record.summary.eligibleInvoices} fatura(s) apta(s) aguardam aprovação.`
    });
    return;
  }
  if (req.method === 'PATCH') {
    const body = await parseJsonBody(req, 16384);
    const result = await approvePaymentImport(body);
    const liquidated = result.results.filter((item) => item.status === 'liquidated').length;
    const alreadySettled = result.results.filter((item) => item.status === 'already_settled').length;
    const failed = result.results.length - liquidated - alreadySettled;
    sendJson(res, 200, {
      ...result,
      message: `${liquidated} fatura(s) liquidada(s), ${alreadySettled} já liquidada(s) e ${failed} não concluída(s).`
    });
    return;
  }
  res.setHeader('Allow', 'GET, POST, PATCH');
  sendJson(res, 405, { message: 'Método não permitido.' });
};

const handleLiquidationLog = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  sendJson(res, 200, { entries: await listLiquidationLog() });
};

const handleBankReconciliationIssues = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method === 'GET') {
    sendJson(res, 200, { issues: await store.listBankReconciliationIssues() });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 512);
  if (!['ignore', 'resume'].includes(body.action)) {
    sendJson(res, 422, { message: 'Ação de pendência inválida.' });
    return;
  }
  const runId = randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    sendJson(res, 409, { message: 'Uma conferência está em andamento. Tente novamente em instantes.' });
    return;
  }
  try {
    const result = body.action === 'ignore'
      ? await store.ignoreBankReconciliationIssue(body.invoiceId)
      : await store.resumeBankReconciliationIssue(body.invoiceId);
    sendJson(res, 200, {
      ...result,
      message: body.action === 'ignore'
        ? `Fatura ${result.invoiceId} retirada da fila de liquidação. A cobrança dela continua bloqueada até uma verificação segura.`
        : `Fatura ${result.invoiceId} devolvida à fila de liquidação.`
    });
  } finally {
    await store.releaseProcessingRun(runId);
  }
};

const handleBankDiagnostic = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const result = await runBankQueryDiagnostic();
  sendJson(res, 200, result);
};

const handleItauDetailDiagnostic = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const rawInvoiceId = String(query.id || '').trim();
  if (rawInvoiceId && (!/^\d{1,20}$/.test(rawInvoiceId) || Number(rawInvoiceId) <= 0)) {
    sendJson(res, 422, { message: 'Número da fatura inválido.' });
    return;
  }
  const invoiceId = rawInvoiceId.replace(/^0+(?=\d)/, '');
  sendJson(res, 200, {
    readOnly: true,
    result: await diagnoseItauDetailQuery({ invoiceId })
  });
};

const handleItauReconciliationPreview = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const invoiceId = String(query.id || '').trim();
  if (!/^\d{1,20}$/.test(invoiceId) || Number(invoiceId) <= 0) {
    sendJson(res, 422, { message: 'Número da fatura inválido.' });
    return;
  }
  sendJson(res, 200, await previewItauReconciliation({
    invoiceId: invoiceId.replace(/^0+(?=\d)/, ''),
    currentDate: saoPauloDate()
  }));
};

const handleItauReconciliationRun = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 512);
  const invoiceId = String(body.invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(invoiceId) || Number(invoiceId) <= 0) {
    sendJson(res, 422, { message: 'Número da fatura inválido.' });
    return;
  }
  sendJson(res, 200, await reconcileItauInvoice({
    invoiceId: invoiceId.replace(/^0+(?=\d)/, ''),
    currentDate: saoPauloDate()
  }));
};

const handleItauReconciliationRearm = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 512);
  const invoiceId = String(body.invoiceId || '').trim();
  sendJson(res, 200, await rearmItauReconciliation({
    invoiceId,
    currentDate: saoPauloDate()
  }));
};

const handleBankReconciliationPreview = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const invoiceId = String(query.id || '').trim();
  if (!/^\d{1,20}$/.test(invoiceId) || Number(invoiceId) <= 0) {
    sendJson(res, 422, { message: 'Número da fatura inválido.' });
    return;
  }
  sendJson(res, 200, await previewBankReconciliation({
    invoiceId: invoiceId.replace(/^0+(?=\d)/, ''),
    currentDate: saoPauloDate()
  }));
};

const handleBankReconciliationInvoice = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 512);
  const invoiceId = String(body.invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(invoiceId) || Number(invoiceId) <= 0) {
    sendJson(res, 422, { message: 'Número da fatura inválido.' });
    return;
  }
  sendJson(res, 200, await reconcileBankInvoice({
    invoiceId: invoiceId.replace(/^0+(?=\d)/, ''),
    currentDate: saoPauloDate()
  }));
};

const handleBankReconciliationBatch = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 512);
  const afterInvoiceId = String(body.afterInvoiceId || '').trim();
  if (afterInvoiceId && !/^\d{1,20}$/.test(afterInvoiceId)) {
    sendJson(res, 422, { message: 'Cursor de liquidação inválido.' });
    return;
  }
  const runId = randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    sendJson(res, 409, { message: 'Outra verificação financeira está em andamento. Tente novamente em instantes.' });
    return;
  }
  try {
    const result = await reconcileBankPayments({
      currentDate: saoPauloDate(),
      maxRecords: 8,
      manualFullScan: true,
      afterInvoiceId
    });
    await store.updateBankReconciliationFailures({
      failed: result.results.filter((item) => ['error', 'in_progress'].includes(item.status)),
      cleared: result.results.filter((item) => ['pending', 'liquidated', 'already_settled'].includes(item.status))
        .map((item) => item.invoiceId)
    });
    sendJson(res, 200, result);
  } finally {
    await store.releaseProcessingRun(runId).catch((error) => {
      console.error('[faturamento:liquidacao:liberacao]', error);
    });
  }
};

const runCronBankReconciliationBatch = async (dependencies = {}) => {
  const afterInvoiceId = await (
    dependencies.getCursor || store.getAutomaticBankScanCursor
  )();
  const result = await (dependencies.reconcile || reconcileBankPayments)({
    currentDate: dependencies.currentDate || saoPauloDate(),
    maxRecords: 25,
    manualFullScan: true,
    afterInvoiceId
  });
  if (!Array.isArray(result?.errors) || !Array.isArray(result?.results) ||
      result.results.length !== result.checked || typeof result.hasMore !== 'boolean' ||
      result.results.some((item) => !/^\d{1,20}$/.test(String(item?.invoiceId || '')) ||
        !['error', 'in_progress', 'pending', 'liquidated', 'already_settled'].includes(item.status)) ||
      result.errors.some((item) => !/^\d{1,20}$/.test(String(item?.invoiceId || '')))) {
    throw new Error('A conciliação bancária retornou um resultado inválido.');
  }
  const failedIds = result.results.filter((item) => item.status === 'error')
    .map((item) => String(item.invoiceId)).sort();
  const reportedIds = result.errors.map((item) => String(item.invoiceId)).sort();
  if (new Set(result.results.map((item) => String(item.invoiceId))).size !== result.results.length ||
      failedIds.length !== reportedIds.length ||
      failedIds.some((id, index) => id !== reportedIds[index])) {
    throw new Error('A conciliação bancária retornou falhas inconsistentes.');
  }
  if (result.hasMore && (!/^\d{1,20}$/.test(String(result.nextCursor || '')) ||
      BigInt(result.nextCursor) <= BigInt(afterInvoiceId || '0'))) {
    throw new Error('A fila de liquidação automática não avançou.');
  }
  // O bloqueio dos boletos incertos precisa sobreviver ao avanço do cursor
  // entre execuções. Somente uma nova conferência sem erro libera cada ID.
  await (dependencies.updateFailures || store.updateBankReconciliationFailures)({
    failed: result.results.filter((item) => ['error', 'in_progress'].includes(item.status))
      .map((item) => item.status === 'error'
        ? result.errors.find((error) => String(error.invoiceId) === String(item.invoiceId))
        : { ...item, message: 'Outra conciliação está em andamento.' }),
    cleared: result.results.filter((item) => ['pending', 'liquidated', 'already_settled'].includes(item.status))
      .map((item) => item.invoiceId)
  });
  await (dependencies.saveCursor || store.saveAutomaticBankScanCursor)(
    result.hasMore ? result.nextCursor : ''
  );
  return { ...result, bankFailuresPersisted: true };
};

const handleCronBankReconciliationBatch = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!hasCronAuthorization(req)) {
    sendJson(res, 401, { message: 'Agendador não autorizado.' });
    return;
  }
  const runId = randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    console.warn('[faturamento:liquidacao:cron:ocupado]', { runId });
    sendJson(res, 409, { message: 'Outra verificação financeira está em andamento.' });
    return;
  }
  const startedAt = new Date().toISOString();
  try {
    const result = await runCronBankReconciliationBatch();
    console.info('[faturamento:liquidacao:cron:lote]', {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      checked: result.checked,
      settled: result.settled,
      alreadySettled: result.alreadySettled,
      pending: result.pending,
      errors: result.errors.length,
      hasMore: result.hasMore
    });
    sendJson(res, 200, result);
  } catch (error) {
    console.error('[faturamento:liquidacao:cron:falha]', {
      runId,
      startedAt,
      message: String(error?.message || error).slice(0, 300)
    });
    throw error;
  } finally {
    await store.releaseProcessingRun(runId).catch((error) => {
      console.error('[faturamento:liquidacao:cron:liberacao]', error);
    });
  }
};

const handleProcess = async (req, res, query) => {
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
  let bankReconciliationSummary = null;
  if (cron && query.bankReconciled === '1') {
    const fields = {
      checked: query.bankChecked,
      settled: query.bankSettled,
      alreadySettled: query.bankAlreadySettled,
      pending: query.bankPending
    };
    if (Object.values(fields).some((value) => !/^\d{1,6}$/.test(String(value || ''))) ||
        Object.values(fields).some((value) => !Number.isSafeInteger(Number(value))) ||
        Number(fields.settled) + Number(fields.alreadySettled) + Number(fields.pending) > Number(fields.checked)) {
      sendJson(res, 422, { message: 'Resumo da conciliação bancária inválido.' });
      return;
    }
    bankReconciliationSummary = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, Number(value)])
    );
  }
  const continuation = !cron && query.continuation === '1';
  const continuationRunId = String(query.runId || '');
  if (continuation && !/^[0-9a-f-]{36}$/i.test(continuationRunId)) {
    sendJson(res, 422, { message: 'Identificador da verificação inválido.' });
    return;
  }
  const runId = continuation ? continuationRunId : randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    sendJson(res, 409, {
      message: 'Já existe uma verificação de cobrança em andamento. Aguarde a conclusão.'
    });
    return;
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await runBillingCollection({
      source,
      runId,
      continuation,
      bankReconciliationSummary
    });
    const run = {
      runId,
      source,
      status: 'completed',
      startedAt,
      completedAt: result.completedAt,
      scanned: result.scanned,
      discovered: result.discovered,
      reconciled: result.reconciled,
      bankSettled: result.bankSettled,
      bankAlreadySettled: result.bankAlreadySettled,
      bankPending: result.bankPending,
      processed: result.processed,
      sent: result.sent,
      blocked: result.blocked,
      settledInvoices: result.settledInvoices,
      deferredHistorical: result.deferredHistorical,
      alreadyCompleted: result.alreadyCompleted,
      remaining: result.remaining,
      stoppedByLimit: result.stoppedByLimit,
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

const handleResend = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  const body = await parseJsonBody(req, 4096);
  const runId = randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    sendJson(res, 409, {
      message: 'Já existe uma operação de cobrança em andamento. Aguarde a conclusão.'
    });
    return;
  }
  try {
    const result = await resendBillingInvoice(body.invoiceId, {
      runId,
      clientCnpj: body.clientCnpj
    });
    sendJson(res, 200, {
      ...result,
      message: `Cobrança reenviada em ${result.sent} mensagem(ns).${result.retryable
        ? ` ${result.retryable} destinatário(s) não aceito(s); consulte os logs antes de tentar novamente.` : ''}${result.review
        ? ` ${result.review} resultado(s) exigem conferência para evitar duplicidade.` : ''}`
    });
  } finally {
    try {
      await store.releaseProcessingRun(runId);
    } catch (error) {
      console.error('[faturamento:cobranca:liberacao-reenvio]', error);
    }
  }
};

const handleJointBilling = async (req, res, query) => {
  if (!requireSession(req, res)) return;
  if (req.method === 'GET') {
    sendJson(res, 200, await previewJointBilling(query.cnpj));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 65536);
  const runId = randomUUID();
  if (!await store.claimProcessingRun(runId)) {
    sendJson(res, 409, { message: 'Já existe uma operação de cobrança em andamento. Aguarde a conclusão.' });
    return;
  }
  try {
    const result = await sendJointBilling(body);
    sendJson(res, result.status === 'review' ? 202 : 200, {
      ...result,
      message: result.status === 'review'
        ? 'O resultado do envio requer conferência nos logs antes de nova tentativa.'
        : `Cobrança conjunta com ${result.invoiceIds.length} fatura(s) aceita pelo servidor de e-mail. A entrega será confirmada nos logs.`
    });
  } finally {
    try { await store.releaseProcessingRun(runId); } catch (error) {
      console.error('[faturamento:cobranca:liberacao-conjunta]', error);
    }
  }
};

const handleJointBillingRefresh = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!requireSameOrigin(req, res)) return;
  const body = await parseJsonBody(req, 1024);
  sendJson(res, 200, await refreshJointBillingInvoice(body));
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
    if (query.route === 'pending-refresh') return await handlePendingRefresh(req, res);
    if (query.route === 'invoice-detail') return await handleInvoiceDetail(req, res, query);
    if (query.route === 'invoice-block') return await handleInvoiceBlock(req, res);
    if (query.route === 'payment-import') return await handlePaymentImport(req, res, query);
    if (query.route === 'liquidation-log') return await handleLiquidationLog(req, res);
    if (query.route === 'bank-reconciliation-issues') return await handleBankReconciliationIssues(req, res);
    if (query.route === 'bank-diagnostic') return await handleBankDiagnostic(req, res);
    if (query.route === 'itau-v2-diagnostic') return await handleItauDetailDiagnostic(req, res, query);
    if (query.route === 'itau-reconciliation-preview') {
      return await handleItauReconciliationPreview(req, res, query);
    }
    if (query.route === 'itau-reconciliation-run') {
      return await handleItauReconciliationRun(req, res);
    }
    if (query.route === 'itau-reconciliation-rearm') {
      return await handleItauReconciliationRearm(req, res);
    }
    if (query.route === 'bank-reconciliation-preview') {
      return await handleBankReconciliationPreview(req, res, query);
    }
    if (query.route === 'bank-reconciliation-invoice') {
      return await handleBankReconciliationInvoice(req, res);
    }
    if (query.route === 'bank-reconciliation-batch') {
      return await handleBankReconciliationBatch(req, res);
    }
    if (query.route === 'bank-reconciliation-cron') {
      return await handleCronBankReconciliationBatch(req, res);
    }
    if (query.route === 'inactive-clients') return await handleInactiveClients(req, res);
    if (query.route === 'logs') return await handleLogs(req, res, query);
    if (query.route === 'resend') return await handleResend(req, res);
    if (query.route === 'joint-billing') return await handleJointBilling(req, res, query);
    if (query.route === 'joint-billing-refresh') return await handleJointBillingRefresh(req, res);
    if (query.route === 'process') return await handleProcess(req, res, query);
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
module.exports.runCronBankReconciliationBatch = runCronBankReconciliationBatch;
