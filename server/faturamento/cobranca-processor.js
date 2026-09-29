const {
  authenticatedGet,
  buildInvoiceQuery,
  invoiceListFromPayload,
  normalizeVisibleInvoices,
  invoiceMatchesQuery,
  fetchInvoices,
  isPendingInvoice
} = require('./brudam');
const { findDoccobForInvoice } = require('./r2-doccob');
const { fetchInvoicePdfData, buildInvoicePdf } = require('./invoice-pdf');
const { generateInvoiceBankSlip, getInvoiceBankSlipPdf } = require('./boleto');
const { issueInvoiceNfse, getIssuedNfseXml } = require('./nfse');
const { buildDanfsePdf } = require('./danfse');
const {
  BANK_SLIP_CREATION_START_DATE,
  BANK_SLIP_CREATION_BLOCKED_CODE,
  isDslIssuer,
  isTwtIssuer
} = require('./billing-rules');
const {
  normalizeCteKeys,
  resolveInvoiceCteKeys,
  fetchCteXmls
} = require('./cte-documents');
const { parseCteXml, buildDactePdf } = require('./dacte');
const {
  EVENT_TYPES,
  zohoConfig,
  createZohoTransport,
  billingEmailPreview,
  sendBillingEmail
} = require('./cobranca-email');
const { deliveryReference } = require('./cobranca-webhook');
const { isTerminalBillingFailure } = require('./billing-failures');
const store = require('./cobranca-store');

const PAGE_SIZE = 100;
const PLACEHOLDER_EMAIL = '__sem_contato__';
const SCAN_REQUEST_ATTEMPTS = 2;
const TRANSIENT_NETWORK_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ETIMEDOUT'
]);

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

const EVENT_PRIORITY = Object.freeze({
  [EVENT_TYPES.initial]: 1,
  [EVENT_TYPES.reminder]: 2,
  [EVENT_TYPES.overdue]: 3
});

const billingEventForInvoice = (invoice, currentDate) => {
  const dueAt = String(invoice?.dueAt || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
    if (dueAt <= addDays(currentDate, -2)) return EVENT_TYPES.overdue;
    if (dueAt >= currentDate && dueAt <= addDays(currentDate, 2)) return EVENT_TYPES.reminder;
    if (dueAt < currentDate) return null;
  }
  return EVENT_TYPES.initial;
};

const buildBillingQueue = ({
  pending = [],
  today = [],
  reminder = [],
  overdue = [],
  reconciliation = [],
  currentDate
}) => {
  const queue = [];
  const byInvoice = new Map();
  const enqueue = (event, invoices, fromPending = false) => invoices.forEach((invoice) => {
    if (!event) return;
    const invoiceId = String(invoice?.id || '');
    if (!invoiceId) return;
    const current = byInvoice.get(invoiceId);
    if (!current) {
      const item = { key: `${event}:${invoiceId}`, event, invoice, fromPending };
      byInvoice.set(invoiceId, item);
      queue.push(item);
      return;
    }
    const wasFromPending = current.fromPending;
    current.fromPending ||= fromPending;
    if ((EVENT_PRIORITY[event] || 0) >= (EVENT_PRIORITY[current.event] || 0)) {
      current.event = event;
      current.key = `${event}:${invoiceId}`;
      // Um registro pendente contém apenas dados resumidos. Quando a mesma
      // fatura veio da Brudam nesta execução, preserva o objeto completo.
      if (!fromPending || wasFromPending) current.invoice = invoice;
    }
  });

  const pendingInvoices = pending.map((record) => ({
    id: record.invoiceId,
    clientDocument: record.clientCnpj,
    client: record.clientName,
    issuedAt: record.issuedAt,
    dueAt: record.dueAt
  }));
  const actionablePending = pendingInvoices.filter((_invoice, index) => pending[index]?.reason !== 'queued');
  const queuedPending = pendingInvoices.filter((_invoice, index) => pending[index]?.reason === 'queued');
  // Faturas recém-emitidas e lembretes do dia entram primeiro. Logo depois,
  // pendências já conhecidas são revalidadas antes da fila técnica acumulada.
  enqueue(EVENT_TYPES.initial, today);
  enqueue(EVENT_TYPES.reminder, reminder);
  actionablePending.forEach((invoice) => {
    enqueue(billingEventForInvoice(invoice, currentDate), [invoice], true);
  });
  enqueue(EVENT_TYPES.overdue, overdue);
  reconciliation.forEach((invoice) => {
    enqueue(billingEventForInvoice(invoice, currentDate), [invoice]);
  });
  queuedPending.forEach((invoice) => {
    enqueue(billingEventForInvoice(invoice, currentDate), [invoice], true);
  });
  return queue;
};

const rotateBillingQueue = (queue, cursor = 0) => {
  if (!queue.length) return { queue: [], startIndex: 0 };
  const normalizedCursor = Math.max(0, Number(cursor) || 0);
  const startIndex = normalizedCursor % queue.length;
  return {
    queue: [...queue.slice(startIndex), ...queue.slice(0, startIndex)],
    startIndex
  };
};

const positiveInteger = (value, fallback, maximum) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
};

const errorChain = (error) => {
  const chain = [];
  let current = error;
  while (current && chain.length < 5) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
};

const isTransientNetworkError = (error) => errorChain(error).some((item) => (
  TRANSIENT_NETWORK_CODES.has(String(item?.code || '').toUpperCase())
  || String(item?.name || '') === 'AbortError'
  || /fetch failed|connect timeout|network|socket hang up/i.test(String(item?.message || ''))
));

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryTransientNetworkRequest = async (
  operation,
  { attempts = SCAN_REQUEST_ATTEMPTS, wait: waitForRetry = wait } = {}
) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      await waitForRetry(200 * attempt);
    }
  }
  throw lastError;
};

const processorConfig = (env = process.env) => ({
  maxInvoices: positiveInteger(env.BILLING_EMAIL_MAX_INVOICES_PER_RUN, 12, 50),
  maxPages: positiveInteger(env.BILLING_EMAIL_SCAN_PAGES_PER_RUN, 2, 10),
  deadlineMs: positiveInteger(env.BILLING_EMAIL_DEADLINE_MS, 50000, 55000)
});

const fetchInvoiceScanPage = async (input) => {
  const { query, limit, skip } = buildInvoiceQuery(input);
  const result = await retryTransientNetworkRequest(
    () => authenticatedGet(`/financeiro/faturas?${query}`)
  );
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

const scanFailure = (scope, error) => ({
  event: 'scan',
  invoiceId: '',
  stage: scope,
  message: `Consulta ${scope} à Brudam não concluída: ${String(error?.message || error).slice(0, 220)}`
});

const scanInvoicesSafely = async (scope, filters, options) => {
  try {
    return {
      scan: await scanInvoices(filters, options),
      error: null
    };
  } catch (error) {
    const failure = scanFailure(scope, error);
    console.warn('[faturamento:cobranca:scan]', {
      stage: scope,
      message: failure.message,
      code: String(error?.cause?.code || error?.code || '')
    });
    return {
      scan: { invoices: [], pages: 0, hasMore: false, nextSkip: options?.startSkip || 0 },
      error: failure
    };
  }
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

const pendingRecord = (
  invoice,
  current,
  now,
  reason = 'doccob',
  message = '',
  { source = 'manual', runId = '' } = {}
) => ({
  invoiceId: String(invoice.id),
  clientCnpj: String(invoice.clientDocument || current?.clientCnpj || '').replace(/\D/g, ''),
  clientName: String(invoice.client || current?.clientName || 'Não informado'),
  issuedAt: invoice.issuedAt || current?.issuedAt || null,
  dueAt: invoice.dueAt || current?.dueAt || null,
  firstSeenAt: current?.firstSeenAt || now,
  lastCheckedAt: now,
  lastCheckSource: source === 'automatic' ? 'automatic' : 'manual',
  ...(runId ? { lastRunId: String(runId) } : {}),
  attempts: Number(current?.attempts || 0) + 1,
  reason,
  ...(message ? { message: String(message).slice(0, 300) } : {})
});

const queuedRecord = (
  invoice,
  now,
  { source = 'manual', runId = '' } = {}
) => ({
  invoiceId: String(invoice.id),
  clientCnpj: String(invoice.clientDocument || '').replace(/\D/g, ''),
  clientName: String(invoice.client || 'Não informado'),
  issuedAt: invoice.issuedAt || null,
  dueAt: invoice.dueAt || null,
  firstSeenAt: now,
  lastCheckedAt: null,
  discoveredBy: source === 'automatic' ? 'automatic' : 'manual',
  ...(runId ? { lastRunId: String(runId) } : {}),
  attempts: 0,
  reason: 'queued'
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

const buildDslDacteAttachment = async ({ invoiceId, doccob, data, context }) => {
  const issuerCnpj = doccob?.invoice?.issuerCnpj || data.issuer?.document;
  if (!isDslIssuer(issuerCnpj)) return null;

  let cteKeys = normalizeCteKeys(
    (Array.isArray(doccob?.transports) ? doccob.transports : [])
      .map((transport) => transport?.accessKey)
  );
  if (!cteKeys.length) {
    const resolved = await context.resolveInvoiceCteKeys(invoiceId);
    cteKeys = normalizeCteKeys(resolved?.cteKeys || []);
  }
  if (!cteKeys.length) {
    throw Object.assign(new Error('A fatura DSL não possui chave CT-e para gerar o DACTE.'), {
      statusCode: 409,
      expose: true
    });
  }

  const xmls = await context.fetchCteXmls(cteKeys);
  if (xmls.length !== cteKeys.length) {
    throw Object.assign(new Error('Não foi possível gerar todos os DACTEs da fatura DSL.'), {
      statusCode: 502,
      expose: true
    });
  }
  return context.buildDactePdf(xmls.map(context.parseCteXml));
};

const initialDeliveryAlreadyCoveredEvent = async ({ event, invoiceId, email, dueAt, context }) => {
  if (event === EVENT_TYPES.initial) return false;
  const initial = await context.getDelivery(EVENT_TYPES.initial, invoiceId, email);
  if (initial?.state !== 'sent') return false;
  const sentTimestamp = new Date(initial.sentAt || '');
  const sentAt = Number.isNaN(sentTimestamp.getTime()) ? '' : saoPauloDate(sentTimestamp);
  const dueDate = String(dueAt || '').slice(0, 10);
  if (!sentAt || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false;
  if (event === EVENT_TYPES.overdue) return sentAt > dueDate;
  return event === EVENT_TYPES.reminder && sentAt >= addDays(dueDate, -2);
};

const enabledContacts = (category) => Array.isArray(category?.contacts)
  ? category.contacts.filter((contact) => contact?.enabled !== false)
  : [];

const buildTwtNfseAttachment = async ({ invoiceId, doccob, data, context }) => {
  const issuerCnpj = doccob?.invoice?.issuerCnpj || data.issuer?.document;
  if (!isTwtIssuer(issuerCnpj)) return null;

  const issuance = await context.issueInvoiceNfse(invoiceId);
  if (issuance?.status !== 'issued') {
    throw Object.assign(new Error('A NFS-e ainda não está pronta para ser anexada.'), {
      statusCode: 409,
      expose: true
    });
  }
  const { xml } = await context.getIssuedNfseXml(invoiceId);
  return context.buildDanfsePdf(xml);
};

const existingDeliveryPlan = async ({ event, invoiceId, category, context }) => {
  const contacts = enabledContacts(category);
  if (contacts.length === 0) return { fullyClaimed: false, recipientCount: 0 };

  const deliveries = new Map();
  let legacyAlertAlreadySent = false;
  for (const contact of contacts) {
    const email = String(contact.email || '').trim().toLocaleLowerCase('pt-BR');
    const delivery = email ? await context.getDelivery(event, invoiceId, email) : null;
    deliveries.set(email, delivery);
    if (event !== EVENT_TYPES.initial && delivery && delivery.alertDeliveryMode !== 'separate') {
      legacyAlertAlreadySent = true;
    }
  }

  const recipients = [...contacts];
  const alertEmail = String(
    context.emailConfig.alertEmail || context.emailConfig.alertCopy || ''
  ).trim().toLocaleLowerCase('pt-BR');
  if (
    event !== EVENT_TYPES.initial
    && alertEmail
    && !legacyAlertAlreadySent
    && !recipients.some((contact) => String(contact.email || '').toLocaleLowerCase('pt-BR') === alertEmail)
  ) {
    recipients.push({ email: alertEmail });
  }

  for (const contact of recipients) {
    const email = String(contact.email || '').trim().toLocaleLowerCase('pt-BR');
    if (!deliveries.has(email)) {
      deliveries.set(email, email ? await context.getDelivery(event, invoiceId, email) : null);
    }
  }
  return {
    fullyClaimed: recipients.length > 0 && recipients.every((contact) => (
      Boolean(deliveries.get(String(contact.email || '').trim().toLocaleLowerCase('pt-BR')))
    )),
    recipientCount: recipients.length
  };
};

const processInvoiceEvent = async ({ event, invoice, context }) => {
  const now = context.now().toISOString();
  const invoiceId = String(invoice.id);
  const blocked = context.blockedInvoiceIds?.has(invoiceId)
    || (typeof context.getInvoiceBlock === 'function'
      && Boolean((await context.getInvoiceBlock(invoiceId))?.blocked));
  if (blocked) {
    context.summary.blocked = Number(context.summary.blocked || 0) + 1;
    return { skipped: 'blocked' };
  }
  if (context.doccobPendingIds?.has(String(invoice.id))) return;
  const clientCnpj = String(invoice.clientDocument || '').replace(/\D/g, '');
  const doccob = await context.findDoccobForInvoice({
    invoiceId: invoice.id,
    clientCnpj,
    issuedAt: invoice.issuedAt
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
    }, current, now, 'doccob', '', {
      source: context.source,
      runId: context.runId
    });
    await context.savePending(record);
    context.pendingByInvoice.set(String(invoice.id), record);
    context.doccobPendingIds?.add(String(invoice.id));
    context.summary.pendingDoccob += 1;
    return;
  }
  const categoryBeforeInvoiceLookup = clientCnpj ? await context.getCategory(clientCnpj) : null;
  const existingPlan = await existingDeliveryPlan({
    event,
    invoiceId: invoice.id,
    category: categoryBeforeInvoiceLookup,
    context
  });
  if (existingPlan.fullyClaimed) {
    context.summary.alreadySent += existingPlan.recipientCount;
    if (context.pendingByInvoice.has(String(invoice.id))) {
      await context.removePending(invoice.id);
      context.pendingByInvoice.delete(String(invoice.id));
    }
    return;
  }

  const data = await context.fetchInvoicePdfData(invoice.id);
  const resolvedCnpj = String(data.client?.document || clientCnpj).replace(/\D/g, '');
  const category = resolvedCnpj === clientCnpj
    ? categoryBeforeInvoiceLookup
    : await context.getCategory(resolvedCnpj);
  const contacts = enabledContacts(category);
  const missingCustomerContacts = contacts.length === 0;
  if (missingCustomerContacts) {
    const current = context.pendingByInvoice.get(String(invoice.id));
    const record = pendingRecord({
      ...invoice,
      client: data.client?.tradeName || data.client?.name || invoice.client,
      clientDocument: resolvedCnpj
    }, current, now, 'contacts', '', {
      source: context.source,
      runId: context.runId
    });
    await context.savePending(record);
    context.pendingByInvoice.set(String(invoice.id), record);
    if (!context.manualResend) {
      await logOnceWithoutContacts({
        event,
        invoice: { ...invoice, clientDocument: resolvedCnpj },
        addLog: context.addLog,
        claimDelivery: context.claimDelivery,
        now
      });
    }
    context.summary.waitingContacts += 1;
    if (context.manualResend) return;
  }

  const alertEmail = String(
    context.emailConfig.alertEmail || context.emailConfig.alertCopy || ''
  ).trim().toLocaleLowerCase('pt-BR');
  const knownDeliveries = new Map();
  let legacyAlertAlreadySent = false;
  if (event !== EVENT_TYPES.initial && alertEmail) {
    for (const contact of contacts) {
      const email = String(contact.email).toLocaleLowerCase('pt-BR');
      const delivery = await context.getDelivery(event, invoice.id, email);
      knownDeliveries.set(email, delivery);
      if (delivery && delivery.alertDeliveryMode !== 'separate') {
        legacyAlertAlreadySent = true;
      }
    }
  }
  const recipients = [...contacts];
  if (
    event !== EVENT_TYPES.initial
    && alertEmail
    && !legacyAlertAlreadySent
    && !recipients.some((contact) => String(contact.email).toLocaleLowerCase('pt-BR') === alertEmail)
  ) {
    recipients.push({
      id: '__alerta_interno__',
      firstName: 'Adriano',
      lastName: '',
      email: alertEmail
    });
  }
  if (recipients.length === 0) return;

  const unsentContacts = [];
  let alreadyDelivered = 0;
  for (const contact of recipients) {
    const normalizedEmail = String(contact.email).toLocaleLowerCase('pt-BR');
    const delivery = knownDeliveries.has(normalizedEmail)
      ? knownDeliveries.get(normalizedEmail)
      : await context.getDelivery(event, invoice.id, contact.email);
    const coveredByLateInitial = !delivery && await initialDeliveryAlreadyCoveredEvent({
      event,
      invoiceId: invoice.id,
      email: contact.email,
      dueAt: data.invoice?.dueAt || invoice.dueAt,
      context
    });
    if (!delivery && !coveredByLateInitial) unsentContacts.push(contact);
    else alreadyDelivered += 1;
  }
  context.summary.alreadySent += alreadyDelivered;
  if (unsentContacts.length === 0) {
    if (!missingCustomerContacts && context.pendingByInvoice.has(String(invoice.id))) {
      await context.removePending(invoice.id);
      context.pendingByInvoice.delete(String(invoice.id));
    }
    return;
  }

  const invoicePdf = await context.buildInvoicePdf(data);
  const dactePdf = await buildDslDacteAttachment({
    invoiceId: invoice.id,
    doccob,
    data,
    context
  });
  const tedDoc = data.invoice?.payment?.type === 'ted_doc';
  let bankSlipPdf = null;
  if (!tedDoc) {
    let bankSlip;
    try {
      bankSlip = await context.generateInvoiceBankSlip(invoice.id);
    } catch (error) {
      if (error?.code !== BANK_SLIP_CREATION_BLOCKED_CODE) throw error;
      if (context.pendingByInvoice.has(String(invoice.id))) {
        await context.removePending(invoice.id);
        context.pendingByInvoice.delete(String(invoice.id));
      }
      context.summary.skippedBankSlipCutoff = Number(
        context.summary.skippedBankSlipCutoff || 0
      ) + 1;
      return { skipped: 'bank_slip_before_cutoff' };
    }
    if (bankSlip.status !== 'ready') {
      throw Object.assign(new Error('O boleto ainda não está pronto para ser anexado.'), {
        statusCode: 409,
        expose: true
      });
    }
    bankSlipPdf = await context.getInvoiceBankSlipPdf(invoice.id);
  }
  const nfsePdf = await buildTwtNfseAttachment({
    invoiceId: invoice.id,
    doccob,
    data,
    context
  });

  for (const contact of unsentContacts) {
    const internalAlert = contact.id === '__alerta_interno__';
    const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const deliveryEvent = context.deliveryEvent ? context.deliveryEvent(event) : event;
    const clientReference = (context.deliveryReference || deliveryReference)(
      event,
      invoice.id,
      contact.email
    );
    const manualMetadata = context.manualResend
      ? { manualResend: true, manualAttemptId: context.runId }
      : {};
    const deliveryMetadata = internalAlert
      ? { recipientRole: 'internal_alert', ...manualMetadata }
      : event === EVENT_TYPES.initial
        ? manualMetadata
        : { alertDeliveryMode: 'separate', ...manualMetadata };
    const emailPreview = billingEmailPreview({
      event,
      data,
      contact,
      dactePdf,
      nfsePdf,
      bankSlipPdf,
      config: context.emailConfig
    });
    const claimed = await context.claimDelivery(deliveryEvent, invoice.id, contact.email, {
      state: 'processing',
      createdAt: now,
      clientReference,
      ...deliveryMetadata
    });
    if (!claimed) {
      context.summary.alreadySent += 1;
      continue;
    }
    try {
      await context.saveDeliveryReference(clientReference, {
        event: deliveryEvent,
        billingEvent: event,
        invoiceId: String(invoice.id),
        clientCnpj: resolvedCnpj,
        clientName: data.client?.tradeName || data.client?.name || invoice.client,
        contactName,
        email: contact.email,
        emailPreview,
        ...manualMetadata,
        ...(internalAlert ? { recipientRole: 'internal_alert' } : {})
      });
      const result = await context.sendBillingEmail({
        event,
        data,
        contact,
        invoicePdf,
        dactePdf,
        nfsePdf,
        bankSlipPdf,
        clientReference,
        transport: context.transport,
        config: context.emailConfig
      });
      const record = {
        state: 'sent',
        sentAt: context.now().toISOString(),
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
        clientReference,
        emailPreview,
        ...deliveryMetadata
      };
      await context.saveDelivery(deliveryEvent, invoice.id, contact.email, record);
      await context.addLog({
        createdAt: record.sentAt,
        event,
        status: 'submitted',
        invoiceId: String(invoice.id),
        clientCnpj: resolvedCnpj,
        clientName: data.client?.tradeName || data.client?.name || invoice.client,
        contactName,
        email: contact.email,
        ...(internalAlert ? { recipientRole: 'internal_alert' } : {}),
        clientReference,
        messageId: result.messageId,
        emailPreview,
        ...manualMetadata,
        message: 'Mensagem aceita pelo SMTP do Zoho; a confirmação de entrega ainda está pendente.'
      });
      context.summary.sent += 1;
      context.sentInvoiceIds?.add(String(invoice.id));
    } catch (error) {
      const failedAt = context.now().toISOString();
      await context.saveDelivery(deliveryEvent, invoice.id, contact.email, {
        state: 'review',
        failedAt,
        clientReference,
        emailPreview,
        message: String(error.message || error).slice(0, 300),
        ...deliveryMetadata
      });
      await context.addLog({
        createdAt: failedAt,
        event,
        status: 'review',
        invoiceId: String(invoice.id),
        clientCnpj: resolvedCnpj,
        clientName: data.client?.tradeName || data.client?.name || invoice.client,
        contactName,
        email: contact.email,
        ...(internalAlert ? { recipientRole: 'internal_alert' } : {}),
        clientReference,
        emailPreview,
        ...manualMetadata,
        message: 'O resultado do envio precisa de conferência manual para evitar duplicidade.'
      });
      context.summary.review += 1;
    }
  }
  if (!missingCustomerContacts && context.pendingByInvoice.has(String(invoice.id))) {
    await context.removePending(invoice.id);
    context.pendingByInvoice.delete(String(invoice.id));
  }
};

const createProcessorContext = ({
  summary,
  pendingByInvoice,
  emailConfig,
  transport,
  nowFactory,
  dependencies = {}
}) => ({
  source: summary.source,
  runId: String(dependencies.runId || ''),
  now: nowFactory,
  summary,
  pendingByInvoice,
  emailConfig,
  transport,
  manualResend: Boolean(dependencies.manualResend),
  blockedInvoiceIds: dependencies.blockedInvoiceIds || new Set(),
  sentInvoiceIds: new Set(),
  doccobPendingIds: new Set(),
  findDoccobForInvoice: dependencies.findDoccobForInvoice || findDoccobForInvoice,
  fetchInvoicePdfData: dependencies.fetchInvoicePdfData || fetchInvoicePdfData,
  buildInvoicePdf: dependencies.buildInvoicePdf || buildInvoicePdf,
  resolveInvoiceCteKeys: dependencies.resolveInvoiceCteKeys || resolveInvoiceCteKeys,
  fetchCteXmls: dependencies.fetchCteXmls || fetchCteXmls,
  parseCteXml: dependencies.parseCteXml || parseCteXml,
  buildDactePdf: dependencies.buildDactePdf || buildDactePdf,
  issueInvoiceNfse: dependencies.issueInvoiceNfse || issueInvoiceNfse,
  getIssuedNfseXml: dependencies.getIssuedNfseXml || getIssuedNfseXml,
  buildDanfsePdf: dependencies.buildDanfsePdf || buildDanfsePdf,
  generateInvoiceBankSlip: dependencies.generateInvoiceBankSlip || generateInvoiceBankSlip,
  getInvoiceBankSlipPdf: dependencies.getInvoiceBankSlipPdf || getInvoiceBankSlipPdf,
  sendBillingEmail: dependencies.sendBillingEmail || sendBillingEmail,
  deliveryReference: dependencies.deliveryReference || deliveryReference,
  deliveryEvent: dependencies.deliveryEvent || ((event) => event),
  getCategory: dependencies.getCategory || store.getCategory,
  savePending: dependencies.savePending || store.savePending,
  removePending: dependencies.removePending || store.removePending,
  getDelivery: dependencies.getDelivery || store.getDelivery,
  claimDelivery: dependencies.claimDelivery || store.claimDelivery,
  saveDelivery: dependencies.saveDelivery || store.saveDelivery,
  saveDeliveryReference: dependencies.saveDeliveryReference || store.saveDeliveryReference,
  addLog: dependencies.addLog || store.addLog,
  getInvoiceBlock: dependencies.getInvoiceBlock || store.getInvoiceBlock,
  markBillingEventCompleted: dependencies.markBillingEventCompleted || store.markBillingEventCompleted
});

const resendBillingInvoice = async (invoiceId, dependencies = {}) => {
  const normalizedId = String(invoiceId || '').trim().replace(/^0+(?=\d)/, '');
  if (!/^\d{1,20}$/.test(normalizedId) || Number(normalizedId) <= 0) {
    throw Object.assign(new Error('Informe o número da fatura.'), { statusCode: 422, expose: true });
  }
  const fetch = dependencies.fetchInvoice || fetchInvoices;
  const clientCnpj = String(dependencies.clientCnpj || '').replace(/\D/g, '');
  let invoice = null;
  let lookupError = null;
  try {
    const result = await fetch({ id: normalizedId, limit: 100 });
    invoice = result.invoices?.find((item) => String(item.id) === normalizedId) || null;
  } catch (error) {
    lookupError = error;
  }
  if (!invoice && clientCnpj.length === 14) {
    try {
      const result = await fetch({ cnpj: clientCnpj, limit: 100 });
      invoice = result.invoices?.find((item) => (
        String(item.id) === normalizedId &&
        String(item.clientDocument || '').replace(/\D/g, '') === clientCnpj
      )) || null;
    } catch (error) {
      lookupError ||= error;
    }
  }
  if (!invoice) {
    if (lookupError && clientCnpj.length !== 14) throw lookupError;
    throw Object.assign(new Error('Fatura não encontrada na Brudam.'), {
      statusCode: 404,
      expose: true
    });
  }
  if ((await (dependencies.getInvoiceBlock || store.getInvoiceBlock)(normalizedId))?.blocked) {
    throw Object.assign(new Error('O envio desta fatura está bloqueado manualmente.'), {
      statusCode: 409,
      expose: true
    });
  }
  if (!isPendingInvoice(invoice)) {
    throw Object.assign(new Error('Somente faturas em aberto podem ser reenviadas.'), {
      statusCode: 409,
      expose: true
    });
  }

  const nowFactory = dependencies.now || (() => new Date());
  const currentDate = saoPauloDate(dependencies.currentTime || nowFactory());
  const event = billingEventForInvoice(invoice, currentDate) || EVENT_TYPES.initial;
  const pending = await (dependencies.listPending || store.listPending)();
  const pendingByInvoice = new Map(pending.map((record) => [String(record.invoiceId), record]));
  const summary = {
    source: 'manual',
    currentDate,
    startedAt: nowFactory().toISOString(),
    completedAt: null,
    scanned: 1,
    processed: 0,
    sent: 0,
    alreadySent: 0,
    pendingDoccob: 0,
    waitingContacts: 0,
    skippedBankSlipCutoff: 0,
    blocked: 0,
    review: 0,
    errors: [],
    stoppedByLimit: false
  };
  const emailConfig = dependencies.emailConfig || zohoConfig();
  const transport = dependencies.transport || createZohoTransport(emailConfig);
  const attemptId = String(dependencies.runId || `manual-${Date.now()}`);
  const contextDependencies = {
    ...dependencies,
    runId: attemptId,
    manualResend: true,
    getDelivery: async () => null,
    claimDelivery: async () => true,
    deliveryReference: (event, id, email) => deliveryReference(event, id, email, attemptId),
    deliveryEvent: () => `manual_${attemptId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`
  };
  const context = createProcessorContext({
    summary,
    pendingByInvoice,
    emailConfig,
    transport,
    nowFactory,
    dependencies: contextDependencies
  });
  let outcome = null;
  try {
    outcome = await processInvoiceEvent({
      event,
      invoice,
      context
    });
    summary.processed = 1;
  } finally {
    if (!dependencies.transport && typeof transport.close === 'function') transport.close();
  }
  summary.completedAt = nowFactory().toISOString();
  if (outcome?.skipped === 'bank_slip_before_cutoff') {
    throw Object.assign(new Error(
      `A geração de um novo boleto está bloqueada para faturas emitidas antes de ${BANK_SLIP_CREATION_START_DATE.split('-').reverse().join('/')}. O reenvio continua permitido quando já existe boleto registrado ou quando o pagamento é TED/DOC.`
    ), { statusCode: 409, expose: true });
  }
  if (outcome?.skipped === 'blocked') {
    throw Object.assign(new Error('O envio desta fatura está bloqueado manualmente.'), {
      statusCode: 409,
      expose: true
    });
  }
  if (summary.pendingDoccob) {
    throw Object.assign(new Error('O DOCCOB ainda não foi localizado. A cobrança não foi reenviada.'), {
      statusCode: 409,
      expose: true
    });
  }
  if (summary.waitingContacts) {
    throw Object.assign(new Error('Não há destinatário ativo para reenviar esta cobrança.'), {
      statusCode: 409,
      expose: true
    });
  }
  if (!summary.sent) {
    throw Object.assign(new Error('O reenvio precisa de conferência nos logs antes de uma nova tentativa.'), {
      statusCode: 502,
      expose: true
    });
  }
  return {
    invoiceId: normalizedId,
    event,
    sent: summary.sent,
    review: summary.review,
    completedAt: summary.completedAt
  };
};

const runBillingCollection = async (dependencies = {}) => {
  const config = dependencies.config || processorConfig();
  const continuation = Boolean(dependencies.continuation);
  const currentDate = saoPauloDate(dependencies.currentTime || new Date());
  const nowFactory = dependencies.now || (() => new Date());
  const startedAt = nowFactory();
  const deadline = startedAt.getTime() + config.deadlineMs;
  const [pending, queueCursor, overdueStart, reconciliationStart] = await Promise.all([
    (dependencies.listPending || store.listPending)(),
    (dependencies.getBillingQueueCursor || store.getBillingQueueCursor)(),
    (dependencies.getOverdueCursor || store.getOverdueCursor)(),
    (dependencies.getReconciliationCursor || store.getReconciliationCursor)()
  ]);
  const pendingByInvoice = new Map(pending.map((record) => [String(record.invoiceId), record]));
  const fetch = dependencies.fetchInvoices || fetchInvoiceScanPage;

  const emptyScan = { invoices: [], pages: 0, hasMore: false, nextSkip: 0 };
  const scanResults = continuation
    ? [
      { scan: emptyScan, error: null },
      { scan: emptyScan, error: null },
      { scan: emptyScan, error: null },
      { scan: emptyScan, error: null }
    ]
    : await Promise.all([
      scanInvoicesSafely('faturas emitidas hoje', { 'emissao[eq]': currentDate, status: '0' }, {
        maxPages: config.maxPages,
        fetch
      }),
      scanInvoicesSafely('faturas perto do vencimento', {
        'vencimento[eq]': addDays(currentDate, 2),
        status: '0'
      }, { maxPages: config.maxPages, fetch }),
      scanInvoicesSafely('faturas vencidas', {
        'vencimento[lte]': addDays(currentDate, -2),
        status: '0'
      }, {
        startSkip: overdueStart,
        maxPages: config.maxPages,
        fetch
      }),
      scanInvoicesSafely('reconciliação de faturas em aberto', { status: '0' }, {
        startSkip: reconciliationStart,
        maxPages: config.maxPages,
        fetch
      })
    ]);
  const [todayResult, reminderResult, overdueResult, reconciliationResult] = scanResults;
  const todayScan = todayResult.scan;
  const reminderScan = reminderResult.scan;
  const overdueScan = overdueResult.scan;
  const reconciliationScan = reconciliationResult.scan;
  const scanErrors = scanResults.map((result) => result.error).filter(Boolean);
  if (!continuation) {
    const cursorUpdates = [];
    if (!overdueResult.error) {
      cursorUpdates.push(
        (dependencies.saveOverdueCursor || store.saveOverdueCursor)(overdueScan.nextSkip)
      );
    }
    if (!reconciliationResult.error) {
      cursorUpdates.push(
        (dependencies.saveReconciliationCursor || store.saveReconciliationCursor)(
          reconciliationScan.nextSkip
        )
      );
    }
    await Promise.all(cursorUpdates);
  }

  const queue = buildBillingQueue({
    pending: continuation
      ? pending.filter((record) => record.reason === 'queued')
      : pending,
    today: todayScan.invoices,
    reminder: reminderScan.invoices,
    overdue: overdueScan.invoices,
    reconciliation: reconciliationScan.invoices,
    currentDate
  });
  const blockedInvoiceIds = new Set(
    await (dependencies.listBlockedInvoiceIds || store.listBlockedInvoiceIds)()
  );
  const unblockedQueue = queue.filter(({ invoice }) => !blockedInvoiceIds.has(String(invoice.id)));
  const completedEventFields = await (
    dependencies.getCompletedBillingEvents || store.getCompletedBillingEvents
  )(unblockedQueue.map(({ event, invoice }) => ({ event, invoiceId: invoice.id })));
  const activeQueue = unblockedQueue.filter(({ key }) => !completedEventFields.has(key));
  const priorityInvoiceIds = new Set([
    ...todayScan.invoices,
    ...reminderScan.invoices,
    ...pending.filter((record) => record.reason !== 'queued')
  ].map((invoice) => String(invoice.id || invoice.invoiceId || '')));
  const discoveredAt = nowFactory().toISOString();
  const newlyQueued = activeQueue
    .filter(({ invoice }) => !pendingByInvoice.has(String(invoice.id)))
    .map(({ invoice }) => queuedRecord(invoice, discoveredAt, {
      source: dependencies.source,
      runId: dependencies.runId
    }));
  if (newlyQueued.length) {
    await (dependencies.savePendingBatch || store.savePendingBatch)(newlyQueued);
    newlyQueued.forEach((record) => pendingByInvoice.set(record.invoiceId, record));
  }
  const priorityQueue = activeQueue.filter(({ invoice }) => (
    priorityInvoiceIds.has(String(invoice.id))
  ));
  const backlogQueue = activeQueue.filter(({ invoice }) => (
    !priorityInvoiceIds.has(String(invoice.id))
  ));
  const rotatedBacklog = rotateBillingQueue(backlogQueue, continuation ? 0 : queueCursor);
  const processingQueue = [...priorityQueue, ...rotatedBacklog.queue];

  const summary = {
    source: dependencies.source === 'automatic' ? 'automatic' : 'manual',
    continuation,
    currentDate,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    scanned: queue.length,
    discovered: newlyQueued.length,
    reconciled: reconciliationScan.invoices.length,
    processed: 0,
    sent: 0,
    alreadySent: 0,
    pendingDoccob: 0,
    waitingContacts: 0,
    skippedBankSlipCutoff: 0,
    blocked: queue.length - unblockedQueue.length,
    alreadyCompleted: unblockedQueue.length - activeQueue.length,
    scanFailures: scanErrors.length,
    remaining: 0,
    review: 0,
    errors: [...scanErrors],
    stoppedByLimit: false
  };

  const emailConfig = dependencies.emailConfig || zohoConfig();
  const transport = dependencies.transport || createZohoTransport(emailConfig);
  const context = createProcessorContext({
    summary,
    pendingByInvoice,
    emailConfig,
    transport,
    nowFactory,
    dependencies: { ...dependencies, blockedInvoiceIds }
  });

  let examined = 0;
  let examinedBacklog = 0;
  try {
    for (const item of processingQueue) {
      if (summary.processed >= config.maxInvoices || Date.now() >= deadline) {
        summary.stoppedByLimit = true;
        break;
      }
      examined += 1;
      if (!priorityInvoiceIds.has(String(item.invoice.id))) examinedBacklog += 1;
      try {
        if (item.event !== EVENT_TYPES.initial && context.sentInvoiceIds.has(String(item.invoice.id))) {
          summary.processed += 1;
          continue;
        }
        const outcome = await processInvoiceEvent({ ...item, context });
        if (
          outcome?.skipped !== 'blocked'
          && !context.pendingByInvoice.has(String(item.invoice.id))
        ) {
          await context.markBillingEventCompleted(item.event, item.invoice.id, {
            completedAt: context.now().toISOString(),
            clientCnpj: String(item.invoice.clientDocument || '').replace(/\D/g, '')
          });
        }
      } catch (error) {
        const failure = {
          event: item.event,
          invoiceId: String(item.invoice.id),
          message: String(error.message || error).slice(0, 300)
        };
        summary.errors.push(failure);
        if (isTerminalBillingFailure(failure)) {
          try {
            await context.removePending(item.invoice.id);
            context.pendingByInvoice.delete(String(item.invoice.id));
            await context.markBillingEventCompleted(item.event, item.invoice.id, {
              completedAt: context.now().toISOString(),
              terminalFailure: failure.message
            });
          } catch {
            // O log preserva o diagnóstico mesmo se a limpeza do estado antigo falhar.
          }
        } else {
          try {
            const current = context.pendingByInvoice.get(String(item.invoice.id));
            const record = pendingRecord(
              item.invoice,
              current,
              context.now().toISOString(),
              'processing_error',
              failure.message,
              {
                source: context.source,
                runId: context.runId
              }
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
    summary.remaining = summary.stoppedByLimit
      ? Math.max(0, activeQueue.length - examined)
      : 0;
    const nextCursor = summary.stoppedByLimit && backlogQueue.length
      ? (rotatedBacklog.startIndex + examinedBacklog) % backlogQueue.length
      : 0;
    if (!continuation) {
      await (dependencies.saveBillingQueueCursor || store.saveBillingQueueCursor)(nextCursor);
    }
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
  billingEventForInvoice,
  buildBillingQueue,
  rotateBillingQueue,
  isTransientNetworkError,
  retryTransientNetworkRequest,
  processorConfig,
  fetchInvoiceScanPage,
  scanInvoices,
  pendingRecord,
  queuedRecord,
  buildDslDacteAttachment,
  buildTwtNfseAttachment,
  initialDeliveryAlreadyCoveredEvent,
  existingDeliveryPlan,
  isTerminalBillingFailure,
  processInvoiceEvent,
  createProcessorContext,
  resendBillingInvoice,
  runBillingCollection
};
