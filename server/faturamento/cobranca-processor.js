const {
  authenticatedGet,
  buildInvoiceQuery,
  invoiceListFromPayload,
  normalizeVisibleInvoices,
  invoiceMatchesQuery
} = require('./brudam');
const { findDoccobForInvoice } = require('./r2-doccob');
const { fetchInvoicePdfData, buildInvoicePdf } = require('./invoice-pdf');
const { generateInvoiceBankSlip, getInvoiceBankSlipPdf } = require('./boleto');
const {
  EVENT_TYPES,
  zohoConfig,
  createZohoTransport,
  sendBillingEmail
} = require('./cobranca-email');
const store = require('./cobranca-store');

const PAGE_SIZE = 100;
const PLACEHOLDER_EMAIL = '__sem_contato__';

const saoPauloDate = (value = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const addDays = (date, amount) => {
  const [year, month, day] = String(date).split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + Number(amount || 0)));
  return value.toISOString().slice(0, 10);
};

const positiveInteger = (value, fallback, maximum) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
};

const processorConfig = (env = process.env) => ({
  maxInvoices: positiveInteger(env.BILLING_EMAIL_MAX_INVOICES_PER_RUN, 12, 50),
  maxPages: positiveInteger(env.BILLING_EMAIL_SCAN_PAGES_PER_RUN, 2, 10),
  deadlineMs: positiveInteger(env.BILLING_EMAIL_DEADLINE_MS, 50000, 55000)
});

const fetchInvoiceScanPage = async (input) => {
  const { query, limit, skip } = buildInvoiceQuery(input);
  const result = await authenticatedGet(`/financeiro/faturas?${query}`);
  const rawInvoices = invoiceListFromPayload(result.payload);
  if (!result.response.ok || Number(result.payload?.status) !== 1 || rawInvoices === null) {
    const upstreamMessage = String(result.payload?.message || '').trim();
    const error = new Error(
      upstreamMessage && upstreamMessage.toUpperCase() !== 'OK'
        ? upstreamMessage
        : 'Formato inesperado no retorno de faturas da Brudam.'
    );
    error.statusCode = result.response.status >= 400 ? result.response.status : 502;
    throw error;
  }
  return {
    invoices: normalizeVisibleInvoices(rawInvoices),
    pagination: {
      limit,
      skip,
      hasMore: rawInvoices.length === limit
    }
  };
};

const scanInvoices = async (filters, {
  startSkip = 0,
  maxPages = 2,
  fetch = fetchInvoiceScanPage
} = {}) => {
  const invoices = [];
  const expected = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => expected.set(key, String(value)));
  let skip = startSkip;
  let hasMore = false;
  let pages = 0;
  do {
    const result = await fetch({ ...filters, limit: PAGE_SIZE, skip });
    const page = Array.isArray(result.invoices) ? result.invoices : [];
    invoices.push(...page.filter((invoice) => invoiceMatchesQuery(invoice, expected)));
    hasMore = Boolean(result.pagination?.hasMore);
    pages += 1;
    skip += PAGE_SIZE;
  } while (hasMore && pages < maxPages);
  return { invoices, pages, hasMore, nextSkip: hasMore ? skip : 0 };
};

const pendingRecord = (invoice, current, now, reason = 'doccob', message = '') => ({
  invoiceId: String(invoice.id),
  clientCnpj: String(invoice.clientDocument || current?.clientCnpj || '').replace(/\D/g, ''),
  clientName: String(invoice.client || current?.clientName || 'Não informado'),
  issuedAt: invoice.issuedAt || current?.issuedAt || null,
  dueAt: invoice.dueAt || current?.dueAt || null,
  firstSeenAt: current?.firstSeenAt || now,
  lastCheckedAt: now,
  attempts: Number(current?.attempts || 0) + 1,
  reason,
  ...(message ? { message: String(message).slice(0, 300) } : {})
});

const logOnceWithoutContacts = async ({ event, invoice, addLog, claimDelivery, now }) => {
  const claimed = await claimDelivery(event, invoice.id, PLACEHOLDER_EMAIL, {
    state: 'waiting_contacts',
    createdAt: now
  });
  if (!claimed) return;
  await addLog({
    createdAt: now,
    event,
    status: 'waiting_contacts',
    invoiceId: String(invoice.id),
    clientCnpj: String(invoice.clientDocument || '').replace(/\D/g, ''),
    clientName: invoice.client || 'Não informado',
    message: 'Nenhum e-mail cadastrado para o CNPJ da fatura.'
  });
};

const processInvoiceEvent = async ({ event, invoice, context }) => {
  const now = context.now().toISOString();
  if (context.doccobPendingIds?.has(String(invoice.id))) return;
  const clientCnpj = String(invoice.clientDocument || '').replace(/\D/g, '');
  const doccob = await context.findDoccobForInvoice({
    invoiceId: invoice.id,
    clientCnpj
  });
  if (!doccob) {
    const current = context.pendingByInvoice.get(String(invoice.id));
    let category = null;
    try {
      category = clientCnpj ? await context.getCategory(clientCnpj) : null;
    } catch {
      // A ausência do cadastro de e-mail não impede o controle de DOCCOB pendente.
    }
    const record = pendingRecord({
      ...invoice,
      client: invoice.client || category?.name || current?.clientName
    }, current, now, 'doccob');
    await context.savePending(record);
    context.pendingByInvoice.set(String(invoice.id), record);
    context.doccobPendingIds?.add(String(invoice.id));
    context.summary.pendingDoccob += 1;
    return;
  }

  const data = await context.fetchInvoicePdfData(invoice.id);
  const resolvedCnpj = String(data.client?.document || clientCnpj).replace(/\D/g, '');
  const category = await context.getCategory(resolvedCnpj);
  const contacts = Array.isArray(category?.contacts) ? category.contacts : [];
  if (contacts.length === 0) {
    const current = context.pendingByInvoice.get(String(invoice.id));
    const record = pendingRecord({
      ...invoice,
      client: data.client?.tradeName || data.client?.name || invoice.client,
      clientDocument: resolvedCnpj
    }, current, now, 'contacts');
    await context.savePending(record);
    context.pendingByInvoice.set(String(invoice.id), record);
    await logOnceWithoutContacts({
      event,
      invoice: { ...invoice, clientDocument: resolvedCnpj },
      addLog: context.addLog,
      claimDelivery: context.claimDelivery,
      now
    });
    context.summary.waitingContacts += 1;
    return;
  }

  const unsentContacts = [];
  for (const contact of contacts) {
    const delivery = await context.getDelivery(event, invoice.id, contact.email);
    if (!delivery) unsentContacts.push(contact);
  }
  if (unsentContacts.length === 0) {
    context.summary.alreadySent += contacts.length;
    if (context.pendingByInvoice.has(String(invoice.id))) {
      await context.removePending(invoice.id);
      context.pendingByInvoice.delete(String(invoice.id));
    }
    return;
  }

  const invoicePdf = await context.buildInvoicePdf(data);
  const tedDoc = data.invoice?.payment?.type === 'ted_doc';
  let bankSlipPdf = null;
  if (!tedDoc) {
    const bankSlip = await context.generateInvoiceBankSlip(invoice.id);
    if (bankSlip.status !== 'ready') {
      throw Object.assign(new Error('O boleto ainda não está pronto para ser anexado.'), {
        statusCode: 409,
        expose: true
      });
    }
    bankSlipPdf = await context.getInvoiceBankSlipPdf(invoice.id);
  }

  for (const contact of unsentContacts) {
    const claimed = await context.claimDelivery(event, invoice.id, contact.email, {
      state: 'processing',
      createdAt: now
    });
    if (!claimed) {
      context.summary.alreadySent += 1;
      continue;
    }
    try {
      const result = await context.sendBillingEmail({
        event,
        data,
        contact,
        invoicePdf,
        bankSlipPdf,
        transport: context.transport,
        config: context.emailConfig
      });
      const record = {
        state: 'sent',
        sentAt: context.now().toISOString(),
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected
      };
      await context.saveDelivery(event, invoice.id, contact.email, record);
      await context.addLog({
        createdAt: record.sentAt,
        event,
        status: 'accepted',
        invoiceId: String(invoice.id),
        clientCnpj: resolvedCnpj,
        clientName: data.client?.tradeName || data.client?.name || invoice.client,
        contactName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
        email: contact.email,
        messageId: result.messageId,
        message: 'Mensagem aceita pelo servidor SMTP do Zoho.'
      });
      context.summary.sent += 1;
      context.sentInvoiceIds?.add(String(invoice.id));
    } catch (error) {
      const failedAt = context.now().toISOString();
      await context.saveDelivery(event, invoice.id, contact.email, {
        state: 'review',
        failedAt,
        message: String(error.message || error).slice(0, 300)
      });
      await context.addLog({
        createdAt: failedAt,
        event,
        status: 'review',
        invoiceId: String(invoice.id),
        clientCnpj: resolvedCnpj,
        clientName: data.client?.tradeName || data.client?.name || invoice.client,
        contactName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
        email: contact.email,
        message: 'O resultado do envio precisa de conferência manual para evitar duplicidade.'
      });
      context.summary.review += 1;
    }
  }
  if (context.pendingByInvoice.has(String(invoice.id))) {
    await context.removePending(invoice.id);
    context.pendingByInvoice.delete(String(invoice.id));
  }
};

const runBillingCollection = async (dependencies = {}) => {
  const config = dependencies.config || processorConfig();
  const currentDate = saoPauloDate(dependencies.currentTime || new Date());
  const nowFactory = dependencies.now || (() => new Date());
  const startedAt = nowFactory();
  const deadline = startedAt.getTime() + config.deadlineMs;
  const pending = await (dependencies.listPending || store.listPending)();
  const pendingByInvoice = new Map(pending.map((record) => [String(record.invoiceId), record]));
  const overdueStart = await (dependencies.getOverdueCursor || store.getOverdueCursor)();
  const fetch = dependencies.fetchInvoices || fetchInvoiceScanPage;

  const [todayScan, reminderScan, overdueScan] = await Promise.all([
    scanInvoices({ 'emissao[eq]': currentDate, status: '0' }, { maxPages: config.maxPages, fetch }),
    scanInvoices({ 'vencimento[eq]': addDays(currentDate, 2), status: '0' }, { maxPages: config.maxPages, fetch }),
    scanInvoices({ 'vencimento[lte]': addDays(currentDate, -1), status: '0' }, {
      startSkip: overdueStart,
      maxPages: config.maxPages,
      fetch
    })
  ]);
  await (dependencies.saveOverdueCursor || store.saveOverdueCursor)(overdueScan.nextSkip);

  const queue = [];
  const enqueue = (event, invoices) => invoices.forEach((invoice) => {
    const key = `${event}:${invoice.id}`;
    if (!queue.some((item) => item.key === key)) queue.push({ key, event, invoice });
  });
  enqueue(EVENT_TYPES.initial, [
    ...pending.map((record) => ({
      id: record.invoiceId,
      clientDocument: record.clientCnpj,
      client: record.clientName,
      issuedAt: record.issuedAt,
      dueAt: record.dueAt
    })),
    ...todayScan.invoices
  ]);
  enqueue(EVENT_TYPES.reminder, reminderScan.invoices);
  enqueue(EVENT_TYPES.overdue, overdueScan.invoices);

  const summary = {
    currentDate,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    scanned: queue.length,
    processed: 0,
    sent: 0,
    alreadySent: 0,
    pendingDoccob: 0,
    waitingContacts: 0,
    review: 0,
    errors: [],
    stoppedByLimit: false
  };

  const emailConfig = dependencies.emailConfig || zohoConfig();
  const transport = dependencies.transport || createZohoTransport(emailConfig);
  const context = {
    now: nowFactory,
    summary,
    pendingByInvoice,
    emailConfig,
    transport,
    sentInvoiceIds: new Set(),
    doccobPendingIds: new Set(),
    findDoccobForInvoice: dependencies.findDoccobForInvoice || findDoccobForInvoice,
    fetchInvoicePdfData: dependencies.fetchInvoicePdfData || fetchInvoicePdfData,
    buildInvoicePdf: dependencies.buildInvoicePdf || buildInvoicePdf,
    generateInvoiceBankSlip: dependencies.generateInvoiceBankSlip || generateInvoiceBankSlip,
    getInvoiceBankSlipPdf: dependencies.getInvoiceBankSlipPdf || getInvoiceBankSlipPdf,
    sendBillingEmail: dependencies.sendBillingEmail || sendBillingEmail,
    getCategory: dependencies.getCategory || store.getCategory,
    savePending: dependencies.savePending || store.savePending,
    removePending: dependencies.removePending || store.removePending,
    getDelivery: dependencies.getDelivery || store.getDelivery,
    claimDelivery: dependencies.claimDelivery || store.claimDelivery,
    saveDelivery: dependencies.saveDelivery || store.saveDelivery,
    addLog: dependencies.addLog || store.addLog
  };

  try {
    for (const item of queue) {
      if (summary.processed >= config.maxInvoices || Date.now() >= deadline) {
        summary.stoppedByLimit = true;
        break;
      }
      try {
        if (item.event !== EVENT_TYPES.initial && context.sentInvoiceIds.has(String(item.invoice.id))) {
          summary.processed += 1;
          continue;
        }
        await processInvoiceEvent({ ...item, context });
      } catch (error) {
        const failure = {
          event: item.event,
          invoiceId: String(item.invoice.id),
          message: String(error.message || error).slice(0, 300)
        };
        summary.errors.push(failure);
        if (item.event === EVENT_TYPES.initial) {
          try {
            const current = context.pendingByInvoice.get(String(item.invoice.id));
            const record = pendingRecord(
              item.invoice,
              current,
              context.now().toISOString(),
              'processing_error',
              failure.message
            );
            await context.savePending(record);
            context.pendingByInvoice.set(String(item.invoice.id), record);
          } catch {
            // O erro original continua disponível no log mesmo se a fila não puder ser atualizada.
          }
        }
        await context.addLog({
          event: item.event,
          status: 'error',
          invoiceId: failure.invoiceId,
          clientCnpj: item.invoice.clientDocument,
          clientName: item.invoice.client,
          message: failure.message
        });
      }
      summary.processed += 1;
    }
  } finally {
    if (!dependencies.transport && typeof transport.close === 'function') transport.close();
  }
  summary.completedAt = nowFactory().toISOString();
  return summary;
};

module.exports = {
  PAGE_SIZE,
  PLACEHOLDER_EMAIL,
  saoPauloDate,
  addDays,
  processorConfig,
  fetchInvoiceScanPage,
  scanInvoices,
  pendingRecord,
  processInvoiceEvent,
  runBillingCollection
};
