const { requiresTedDocPayment } = require('./billing-rules');
const boletoStore = require('./boleto-store');
const cobrancaStore = require('./cobranca-store');
const { isTerminalBillingFailure } = require('./billing-failures');

const digits = (value) => String(value || '').replace(/\D/g, '');

const controlState = (code, label, tone = 'neutral', detail = '') => ({
  code,
  label,
  tone,
  ...(detail ? { detail } : {})
});

const saoPauloToday = (now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const financialState = (invoice, now = new Date()) => {
  const label = String(invoice?.statusLabel || '').toLocaleLowerCase('pt-BR');
  if (Number(invoice?.status) === 2 || label.includes('cancel')) {
    return controlState('cancelled', 'Cancelada', 'neutral');
  }
  if (Number(invoice?.status) === 1 || ['liquid', 'pago', 'quitad'].some((term) => label.includes(term))) {
    return controlState('paid', 'Liquidada', 'success');
  }
  const dueAt = String(invoice?.dueAt || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt) && dueAt < saoPauloToday(now)) {
    return controlState('overdue', 'Vencida', 'danger');
  }
  return controlState('open', 'Em aberto', 'warning');
};

const documentState = (pending, logs = []) => {
  if (pending?.reason === 'doccob') {
    return controlState('awaiting_doccob', 'Aguardando DOCCOB', 'warning', pending.message || '');
  }
  if (
    pending?.reason === 'processing_error' &&
    /dacte|ct-?e|xml|document/i.test(String(pending.message || ''))
  ) {
    return controlState('dacte_unavailable', 'DACTE indisponível', 'danger', pending.message || '');
  }
  if (logs.length || pending?.reason === 'contacts') {
    return controlState('complete', 'Documentos prontos', 'success');
  }
  return controlState('unchecked', 'A conferir', 'neutral');
};

const failedDeliveryStatuses = new Set([
  'soft_bounce', 'hard_bounce', 'bounced', 'review', 'error'
]);
const pendingDeliveryStatuses = new Set(['accepted', 'submitted']);

const collectionState = (logs = []) => {
  if (!logs.length) return controlState('not_sent', 'Não enviada', 'neutral');
  if (logs.some((log) => failedDeliveryStatuses.has(log.status))) {
    return controlState('failed', 'Falha no envio', 'danger');
  }
  if (logs.some((log) => log.status === 'waiting_contacts')) {
    return controlState('no_contacts', 'Sem destinatário', 'warning');
  }
  const deliveryLogs = logs.filter((log) => log.email || log.clientReference);
  if (deliveryLogs.length && deliveryLogs.every((log) => log.status === 'delivered')) {
    return controlState('delivered', 'Entregue', 'success');
  }
  if (deliveryLogs.some((log) => log.status === 'delivered')) {
    return controlState('partial', 'Entrega parcial', 'warning');
  }
  if (logs.some((log) => pendingDeliveryStatuses.has(log.status))) {
    return controlState('sent', 'Enviada', 'info', 'Aguardando confirmação de entrega.');
  }
  return controlState('not_sent', 'Não enviada', 'neutral');
};

const paymentState = (invoice, bankRecord) => {
  if (requiresTedDocPayment({
    clientNames: [invoice?.client],
    clientDocument: invoice?.clientDocument
  })) {
    return controlState('ted_doc', 'TED/DOC', 'info');
  }
  if (bankRecord?.state === 'ready' && bankRecord.bankSlipId) {
    const bank = bankRecord.bank === 'itau' ? 'Itaú' : bankRecord.bank === 'bradesco' ? 'Bradesco' : 'banco';
    return controlState('registered', `Boleto ${bank}`, 'success');
  }
  if (bankRecord?.state === 'review') {
    return controlState('bank_error', 'Conferir no banco', 'danger');
  }
  if (bankRecord?.state === 'processing') {
    return controlState('processing', 'Em processamento', 'warning');
  }
  if (bankRecord?.state === 'validated') {
    return controlState('validated', 'Somente validado', 'warning');
  }
  return controlState('not_generated', 'Não gerado', 'neutral');
};

const invoiceControl = (invoice, { pending = null, logs = [], bankRecord = null, now = new Date() } = {}) => ({
  financial: financialState(invoice, now),
  documents: documentState(pending, logs),
  collection: collectionState(logs),
  payment: paymentState(invoice, bankRecord)
});

const groupByInvoice = (records) => {
  const groups = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = digits(record?.invoiceId);
    if (!id) continue;
    const current = groups.get(id) || [];
    current.push(record);
    groups.set(id, current);
  }
  return groups;
};

const enrichInvoicesWithControl = async (invoices, dependencies = {}) => {
  if (!Array.isArray(invoices) || !invoices.length) return invoices || [];
  const listPending = dependencies.listPending || cobrancaStore.listPending;
  const listLogs = dependencies.listLogs || cobrancaStore.filteredLogs;
  const getBankSlipRecords = dependencies.getBankSlipRecords || boletoStore.getBankSlipRecords;
  const [pending, logs, bankRecords] = await Promise.all([
    listPending(),
    listLogs(),
    getBankSlipRecords(invoices.map((invoice) => invoice.id))
  ]);
  const pendingByInvoice = new Map(pending.map((record) => [digits(record.invoiceId), record]));
  const logsByInvoice = groupByInvoice(logs);
  return invoices.map((invoice) => {
    const id = digits(invoice.id);
    return {
      ...invoice,
      control: invoiceControl(invoice, {
        pending: pendingByInvoice.get(id),
        logs: logsByInvoice.get(id) || [],
        bankRecord: bankRecords.get(id),
        now: dependencies.now?.() || new Date()
      })
    };
  });
};

const priorityFor = (record, type, now = new Date()) => {
  const dueAt = String(record?.dueAt || '').slice(0, 10);
  if (dueAt && dueAt < saoPauloToday(now)) return 'critical';
  if (type === 'email' || type === 'payment' || record?.reason === 'processing_error') return 'high';
  return 'medium';
};

const issueFromPending = (record, now) => {
  const message = String(record.message || '');
  const type = record.reason === 'contacts'
    ? 'contacts'
    : record.reason === 'doccob'
      ? 'documents'
      : /boleto|banco|ita[uú]|bradesco/i.test(message)
        ? 'payment'
        : /dacte|ct-?e|xml|document/i.test(message)
          ? 'documents'
          : 'processing';
  const labels = {
    contacts: 'Cadastrar destinatário',
    documents: record.reason === 'doccob' ? 'Aguardando DOCCOB' : 'Falha nos documentos',
    payment: 'Falha no boleto',
    processing: 'Falha no processamento'
  };
  return {
    id: `pending:${digits(record.invoiceId)}`,
    type,
    priority: priorityFor(record, type, now),
    invoiceId: String(record.invoiceId || ''),
    clientName: record.clientName || 'Não informado',
    clientCnpj: digits(record.clientCnpj),
    issuedAt: record.issuedAt || '',
    dueAt: record.dueAt || '',
    updatedAt: record.lastCheckedAt || record.firstSeenAt || '',
    title: labels[type],
    message: message || labels[type],
    action: type === 'contacts' ? 'contacts' : 'invoice'
  };
};

const issueFromLog = (record, now) => ({
  id: `log:${record.id || record.clientReference || `${digits(record.invoiceId)}:${record.email || ''}`}`,
  type: record.status === 'waiting_contacts' ? 'contacts' : 'email',
  priority: priorityFor(record, 'email', now),
  invoiceId: String(record.invoiceId || ''),
  clientName: record.clientName || 'Não informado',
  clientCnpj: digits(record.clientCnpj),
  dueAt: record.dueAt || '',
  updatedAt: record.createdAt || '',
  title: record.status === 'waiting_contacts' ? 'Cadastrar destinatário' : 'Falha na entrega do e-mail',
  message: record.message || 'O envio precisa de conferência.',
  email: record.email || '',
  action: record.status === 'waiting_contacts' ? 'contacts' : 'logs'
});

const buildUnifiedIssues = ({ pending = [], logs = [], now = new Date() } = {}) => {
  const issues = pending
    .filter((record) => !isTerminalBillingFailure(record))
    .map((record) => issueFromPending(record, now));
  const pendingKeys = new Set(issues.map((issue) => `${digits(issue.invoiceId)}:${issue.type}`));
  for (const log of logs) {
    if (isTerminalBillingFailure(log)) continue;
    if (!failedDeliveryStatuses.has(log.status) && log.status !== 'waiting_contacts') continue;
    if (log.status === 'error' && !log.email && !log.clientReference) continue;
    const issue = issueFromLog(log, now);
    const key = `${digits(issue.invoiceId)}:${issue.type}`;
    if (pendingKeys.has(key)) continue;
    pendingKeys.add(key);
    issues.push(issue);
  }
  const rank = { critical: 0, high: 1, medium: 2 };
  return issues.sort((left, right) =>
    (rank[left.priority] ?? 9) - (rank[right.priority] ?? 9) ||
    String(left.dueAt || '9999').localeCompare(String(right.dueAt || '9999')) ||
    String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
  );
};

const issueSummary = (issues) => ({
  critical: issues.filter((issue) => issue.priority === 'critical').length,
  documents: issues.filter((issue) => issue.type === 'documents').length,
  contacts: issues.filter((issue) => issue.type === 'contacts').length,
  email: issues.filter((issue) => issue.type === 'email').length,
  payment: issues.filter((issue) => issue.type === 'payment').length
});

const buildInvoiceTimeline = ({ invoice, pending = null, logs = [], bankRecord = null } = {}) => {
  const timeline = [];
  if (invoice?.issuedAt) timeline.push({
    at: invoice.issuedAt,
    type: 'invoice',
    title: 'Fatura emitida',
    description: `Fatura ${invoice.id} registrada na Brudam.`
  });
  if (bankRecord?.createdAt || bankRecord?.startedAt || bankRecord?.reviewedAt) timeline.push({
    at: bankRecord.createdAt || bankRecord.reviewedAt || bankRecord.startedAt,
    type: 'payment',
    title: bankRecord.state === 'ready' ? 'Boleto registrado' : 'Tentativa de boleto',
    description: paymentState(invoice, bankRecord).label
  });
  if (pending) timeline.push({
    at: pending.lastCheckedAt || pending.firstSeenAt,
    type: 'pending',
    title: issueFromPending(pending, new Date()).title,
    description: pending.message || 'Pendência aguardando resolução.'
  });
  for (const log of logs) timeline.push({
    at: log.createdAt,
    type: 'email',
    title: `${log.event === 'overdue' ? 'Aviso de vencimento' : log.event === 'reminder' ? 'Lembrete' : 'Cobrança'}: ${collectionState([log]).label}`,
    description: [log.contactName, log.email, log.message].filter(Boolean).join(' · ')
  });
  if (invoice?.dueAt) timeline.push({
    at: invoice.dueAt,
    type: 'due',
    title: 'Vencimento',
    description: financialState(invoice).code === 'overdue' ? 'Prazo de pagamento vencido.' : 'Data prevista para pagamento.'
  });
  return timeline.sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')));
};

module.exports = {
  saoPauloToday,
  financialState,
  documentState,
  collectionState,
  paymentState,
  invoiceControl,
  enrichInvoicesWithControl,
  buildUnifiedIssues,
  issueSummary,
  buildInvoiceTimeline
};
