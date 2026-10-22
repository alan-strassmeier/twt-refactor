const { createHash, randomUUID } = require('node:crypto');
const { fetchInvoices, isPendingInvoice } = require('./brudam');
const { findDoccobForInvoice } = require('./r2-doccob');
const { fetchInvoicePdfData, buildInvoicePdf, applyCategoryBillingMethod } = require('./invoice-pdf');
const { generateInvoiceBankSlip, getInvoiceBankSlipPdf } = require('./boleto');
const { issueInvoiceNfse, getIssuedNfseXml } = require('./nfse');
const { buildDanfsePdf } = require('./danfse');
const { resolveInvoiceCteKeys, fetchCteXmls } = require('./cte-documents');
const { parseCteXml, buildDactePdf } = require('./dacte');
const {
  buildDslDacteAttachment, buildTwtNfseAttachment,
  saoPauloDate, addDays, billingEventForInvoice, automaticBillingEventForInvoice,
  retryTransientNetworkRequest
} = require('./cobranca-processor');
const {
  EVENT_TYPES, zohoConfig, createZohoTransport, billingAttachments,
  jointBillingSubject, jointBillingText, sendJointBillingEmail
} = require('./cobranca-email');
const { deliveryReference } = require('./cobranca-webhook');
const store = require('./cobranca-store');

const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const INVOICE_CHECK_CONCURRENCY = 3;
const EMPTY_INVOICE_RETRIES = 3;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, expose: true });
const digits = (value) => String(value || '').replace(/\D/g, '');
const invoiceId = (value) => String(value || '').trim().replace(/^0+(?=\d)/, '');
const sortIds = (values) => [...new Set(values.map(invoiceId))].sort((left, right) =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
const cents = (value) => Math.round(Number(value) * 100);
const overdueDays = (dueAt, today) => Math.floor((Date.parse(`${today}T00:00:00Z`)
  - Date.parse(`${String(dueAt || '').slice(0, 10)}T00:00:00Z`)) / 86400000);
const isOverdue = (invoice, today) =>
  automaticBillingEventForInvoice(invoice, today) === EVENT_TYPES.overdue;

const fetchExactInvoice = async (id, dependencies = {}) => {
  const fetch = dependencies.fetchCurrentInvoice || dependencies.fetchInvoices || fetchInvoices;
  const wait = dependencies.waitBeforeInvoiceRetry || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= EMPTY_INVOICE_RETRIES; attempt += 1) {
    let result;
    try {
      result = await retryTransientNetworkRequest(() => fetch({ id, limit: 100, fresh: true }));
    } catch (error) {
      throw Object.assign(fail(
        `Não foi possível confirmar a situação da fatura ${id} na Brudam. Nenhum e-mail foi enviado.`, 503
      ), { cause: error });
    }
    const matches = (result?.invoices || []).filter((item) => invoiceId(item.id) === id);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw fail(`A Brudam retornou registros duplicados para a fatura ${id}. Nenhum e-mail foi enviado.`, 503);
    }
    if (attempt === EMPTY_INVOICE_RETRIES) break;
    await wait(200 * attempt);
  }
  throw fail(
    `A Brudam não retornou uma situação financeira inequívoca para a fatura ${id} após ${EMPTY_INVOICE_RETRIES} consultas. Nenhum e-mail foi enviado.`, 503
  );
};

const companyAndInvoices = async (cnpjInput, dependencies = {}, onlyInvoiceIds = null) => {
  const cnpj = digits(cnpjInput);
  if (cnpj.length !== 14) throw fail('Informe um CNPJ válido.', 422);
  const getCategory = dependencies.getCategory || store.getCategory;
  const fetch = dependencies.fetchInvoices || fetchInvoices;
  const category = await getCategory(cnpj);
  if (!category) throw fail('Empresa não cadastrada nos e-mails de cobrança.', 404);
  const today = saoPauloDate(dependencies.now ? dependencies.now() : new Date());
  const result = await fetch({ cnpj, status: '0', 'vencimento[lte]': addDays(today, -2),
    limit: 100, fresh: true });
  if (result?.pagination?.allCompanyInvoicesLoaded !== true && result?.pagination?.hasMore) {
    throw fail('A consulta não retornou todas as faturas da empresa. O envio foi bloqueado.', 503);
  }
  const candidates = (result?.invoices || []).filter((invoice) =>
    digits(invoice.clientDocument) === cnpj && String(invoice.status) === '0'
    && isPendingInvoice(invoice) && isOverdue(invoice, today));
  const candidatesById = new Map(candidates.map((invoice) => [invoiceId(invoice.id), invoice]));
  const candidateEntries = [...candidatesById.entries()]
    .filter(([id]) => !onlyInvoiceIds || onlyInvoiceIds.has(id));
  const checked = new Array(candidateEntries.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(INVOICE_CHECK_CONCURRENCY, candidateEntries.length) }, async () => {
    while (nextIndex < candidateEntries.length) {
      const index = nextIndex++;
      const [id, listed] = candidateEntries[index];
      let current;
      try {
        current = await fetchExactInvoice(id, dependencies);
      } catch (error) {
        checked[index] = { id, issuedAt: listed.issuedAt, dueAt: listed.dueAt,
          balance: null, unverified: true,
          blockReason: error.message.replace(/\s*Nenhum e-mail foi enviado\.\s*$/, '') };
        continue;
      }
      if (String(current.status) !== '0' || !isPendingInvoice(current)) continue;
      if (digits(current.clientDocument) !== cnpj) {
        checked[index] = { id, issuedAt: listed.issuedAt, dueAt: listed.dueAt,
          balance: null, unverified: true,
          blockReason: `O cliente da fatura ${id} não pôde ser confirmado na Brudam.` };
        continue;
      }
      if (isOverdue(current, today)) checked[index] = current;
    }
  }));
  return { cnpj, category, invoices: checked.filter(Boolean).sort((a, b) =>
    BigInt(invoiceId(a.id)) < BigInt(invoiceId(b.id)) ? -1 : 1), today };
};

const previewJointBilling = async (cnpj, dependencies = {}, onlyInvoiceIds = null) => {
  const { category, invoices, today } = await companyAndInvoices(cnpj, dependencies, onlyInvoiceIds);
  const ids = invoices.map((invoice) => invoiceId(invoice.id));
  const [blocks, jointDeliveries] = await Promise.all([
    (dependencies.getInvoiceBlocks || store.getInvoiceBlocks)(ids),
    (dependencies.getJointDeliveries || store.getJointDeliveries)(ids)
  ]);
  const entries = invoices.map((invoice) => {
    const id = invoiceId(invoice.id);
    return {
      id: invoiceId(invoice.id),
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      balance: invoice.unverified ? null : Number(invoice.balance),
      overdueDays: overdueDays(invoice.dueAt, today),
      blocked: Boolean(invoice.unverified || blocks.get(id)?.blocked),
      blockReason: invoice.blockReason || (blocks.get(id)?.blocked ? 'Envio bloqueado para esta fatura.' : ''),
      jointSent: Boolean(jointDeliveries.get(id))
    };
  });
  const recipients = (category.contacts || []).filter((contact) => contact.enabled !== false);
  return {
    company: { cnpj: category.cnpj, name: category.name, billingMethod: category.billingMethod },
    recipients: recipients.map(({ firstName, lastName, email }) => ({ firstName, lastName, email })),
    invoices: entries,
    totalBalance: Math.round(entries.reduce((sum, invoice) => sum + (invoice.balance || 0), 0) * 100) / 100,
    blockedCount: entries.filter((invoice) => invoice.blocked).length,
    jointSentCount: entries.filter((invoice) => invoice.jointSent).length
  };
};

const currentOpenInvoice = async (id, cnpj, dependencies, expectedBalance, expectedDueAt) => {
  const invoice = await fetchExactInvoice(id, dependencies);
  if (digits(invoice.clientDocument) !== cnpj || String(invoice.status) !== '0'
    || !isPendingInvoice(invoice) || cents(invoice.balance) !== cents(expectedBalance)
    || !isOverdue(invoice, saoPauloDate(dependencies.now ? dependencies.now() : new Date()))
    || invoice.dueAt !== expectedDueAt) {
    throw fail(`A fatura ${id} não está mais confirmada como vencida e aberta para esta empresa. Nenhum e-mail foi enviado.`);
  }
  return invoice;
};

const prepareAttachments = async (invoice, category, dependencies) => {
  const id = invoiceId(invoice.id);
  const findDoccob = dependencies.findDoccobForInvoice || findDoccobForInvoice;
  const doccob = await findDoccob({ invoiceId: id, clientCnpj: category.cnpj, issuedAt: invoice.issuedAt });
  if (!doccob) throw fail(`DOCCOB da fatura ${id} não localizado. Nenhum e-mail foi enviado.`);
  const fetchPdfData = dependencies.fetchInvoicePdfData || fetchInvoicePdfData;
  const data = applyCategoryBillingMethod(await fetchPdfData(id), category);
  if (digits(data.client?.document) !== category.cnpj || String(data.invoice?.status) !== '0'
    || !isPendingInvoice(data.invoice) || cents(data.invoice.balance) !== cents(invoice.balance)) {
    throw fail(`A fatura ${id} mudou de cliente ou situação financeira. Nenhum e-mail foi enviado.`);
  }
  const context = {
    resolveInvoiceCteKeys: dependencies.resolveInvoiceCteKeys || resolveInvoiceCteKeys,
    fetchCteXmls: dependencies.fetchCteXmls || fetchCteXmls,
    parseCteXml: dependencies.parseCteXml || parseCteXml,
    buildDactePdf: dependencies.buildDactePdf || buildDactePdf,
    issueInvoiceNfse: dependencies.issueInvoiceNfse || issueInvoiceNfse,
    getIssuedNfseXml: dependencies.getIssuedNfseXml || getIssuedNfseXml,
    buildDanfsePdf: dependencies.buildDanfsePdf || buildDanfsePdf
  };
  const invoicePdf = await (dependencies.buildInvoicePdf || buildInvoicePdf)(data);
  const dactePdf = await buildDslDacteAttachment({ invoiceId: id, doccob, data, context });
  const nfsePdf = await buildTwtNfseAttachment({ invoiceId: id, doccob, data, context });
  let bankSlipPdf = null;
  if (data.invoice.payment?.type !== 'ted_doc') {
    const bankSlip = await (dependencies.generateInvoiceBankSlip || generateInvoiceBankSlip)(id);
    if (bankSlip?.status !== 'ready') throw fail(`Boleto da fatura ${id} ainda não está pronto.`);
    bankSlipPdf = await (dependencies.getInvoiceBankSlipPdf || getInvoiceBankSlipPdf)(id);
  }
  const attachments = billingAttachments({ invoiceId: id, invoicePdf, dactePdf, nfsePdf, bankSlipPdf });
  if (attachments.some((attachment) => !Buffer.isBuffer(attachment.content) || !attachment.content.length)) {
    throw fail(`Um anexo da fatura ${id} está vazio ou inválido. Nenhum e-mail foi enviado.`);
  }
  return attachments;
};

const sendJointBilling = async ({ cnpj: cnpjInput, invoiceIds }, dependencies = {}) => {
  const expectedIds = Array.isArray(invoiceIds) && invoiceIds.length > 0
    && invoiceIds.every((id) => /^\d{1,20}$/.test(String(id)) && Number(id) > 0)
    ? sortIds(invoiceIds) : null;
  if (!expectedIds || expectedIds.length !== invoiceIds.length) {
    throw fail('Confira a lista de faturas antes de enviar.', 422);
  }
  const selectedIds = new Set(expectedIds);
  const preview = await previewJointBilling(cnpjInput, dependencies, selectedIds);
  const cnpj = preview.company.cnpj;
  const selected = expectedIds.map((id) => preview.invoices.find((invoice) => invoice.id === id));
  if (selected.some((invoice) => !invoice)) {
    throw fail('Uma fatura selecionada não está mais vencida e em aberto. Atualize a consulta antes de enviar.');
  }
  if (selected.some((invoice) => invoice.blocked)) {
    throw fail('Há fatura(s) selecionada(s) com envio bloqueado. Ignore-as neste envio para continuar com as demais.');
  }
  if (selected.some((invoice) => invoice.jointSent)) {
    throw fail('Há fatura(s) selecionada(s) já reservadas ou enviadas em conjunto. Ignore-as para continuar com as demais.');
  }
  if (!preview.recipients.length) throw fail('Cadastre ao menos um destinatário ativo para esta empresa.');

  const getCategory = dependencies.getCategory || store.getCategory;
  const initialCategory = await getCategory(cnpj);
  const confirmedInvoices = [];
  for (const id of expectedIds) {
    const expected = preview.invoices.find((item) => item.id === id);
    confirmedInvoices.push(await currentOpenInvoice(id, cnpj, dependencies, expected.balance, expected.dueAt));
  }
  const attachments = [];
  for (const invoice of confirmedInvoices) {
    const id = invoiceId(invoice.id);
    attachments.push(...await prepareAttachments(invoice, initialCategory, dependencies));
    if (attachments.reduce((sum, item) => sum + item.content.length, 0) > MAX_ATTACHMENT_BYTES) {
      throw fail('Os anexos ultrapassam 18 MB. Nenhum e-mail foi enviado.', 413);
    }
  }

  // A lista e o estado financeiro são novamente conferidos imediatamente antes do SMTP.
  const latest = await previewJointBilling(cnpj, dependencies, selectedIds);
  const latestSelected = expectedIds.map((id) => latest.invoices.find((invoice) => invoice.id === id));
  if (latestSelected.some((invoice) => !invoice)) {
    throw fail('Uma fatura selecionada mudou durante a preparação. Nenhum e-mail foi enviado.');
  }
  if (selected.some((invoice, index) => cents(invoice.balance) !== cents(latestSelected[index].balance)
    || invoice.dueAt !== latestSelected[index].dueAt)) {
    throw fail('O saldo de uma fatura mudou durante a preparação. Atualize a consulta antes de enviar.');
  }
  if (preview.company.name !== latest.company.name
    || preview.company.billingMethod !== latest.company.billingMethod) {
    throw fail('O cadastro da empresa mudou durante a preparação. Atualize a consulta antes de enviar.');
  }
  if (latestSelected.some((invoice) => invoice.blocked)) {
    throw fail('Uma fatura selecionada foi bloqueada durante a preparação. Nenhum e-mail foi enviado.');
  }
  if (latestSelected.some((invoice) => invoice.jointSent)) {
    throw fail('Uma fatura selecionada foi reservada por outro envio conjunto. Nenhum e-mail foi enviado.');
  }
  const recipientEmails = preview.recipients.map((contact) => contact.email.toLowerCase()).sort();
  if (recipientEmails.join('|') !== latest.recipients.map((contact) => contact.email.toLowerCase()).sort().join('|')) {
    throw fail('Os destinatários mudaram durante a preparação. Nenhum e-mail foi enviado.');
  }
  for (const id of expectedIds) {
    const expected = preview.invoices.find((item) => item.id === id);
    await currentOpenInvoice(id, cnpj, dependencies, expected.balance, expected.dueAt);
  }
  const today = saoPauloDate(dependencies.now ? dependencies.now() : new Date());
  const selectedTotalBalance = Math.round(selected.reduce((sum, invoice) => sum + invoice.balance, 0) * 100) / 100;
  const selectedInvoices = selected.map(({ id, dueAt }) => ({ id, dueAt, overdueDays: overdueDays(dueAt, today) }));
  const batchId = BigInt(`0x${createHash('sha256').update(`${cnpj}|${today}|${expectedIds.join(',')}`)
    .digest('hex').slice(0, 16)}`).toString();
  const event = 'joint';
  const recipientKey = cnpj;
  const claimId = randomUUID();
  const claim = dependencies.claimDelivery || store.claimDelivery;
  if (!await claim(event, batchId, recipientKey, {
    state: 'processing', claimId, createdAt: new Date().toISOString(), invoiceIds: expectedIds
  })) throw fail('Esta cobrança conjunta já foi enviada ou está em conferência hoje. Consulte os logs antes de tentar novamente.');

  const save = dependencies.saveDelivery || store.saveDelivery;
  const release = dependencies.releaseDeliveryClaim || store.releaseDeliveryClaim;
  const addLog = dependencies.addLog || store.addLog;
  const claimedInvoiceIds = [];
  const billingEvents = new Map(confirmedInvoices.map((invoice) => [invoiceId(invoice.id),
    billingEventForInvoice(invoice, today) || 'initial']));
  const clientReference = deliveryReference(event, batchId, recipientKey);
  const paymentMethod = preview.company.billingMethod === 'ted_doc' ? 'Transferência TED/DOC' : 'Boleto bancário';
  const greetingName = preview.recipients.length === 1
    ? [preview.recipients[0].firstName, preview.recipients[0].lastName].filter(Boolean).join(' ')
    : preview.company.name;
  const emailPreview = {
    fromName: '', fromEmail: '', toName: preview.company.name,
    toEmail: recipientEmails.join(', '), subject: jointBillingSubject,
    text: jointBillingText({ companyName: greetingName, invoices: selectedInvoices,
      paymentMethod, totalBalance: selectedTotalBalance }),
    priority: 'normal', attachments: attachments.map((item) => item.filename)
  };
  const metadata = {
    event, clientCnpj: cnpj, clientName: preview.company.name,
    contactName: preview.company.name, email: recipientEmails.join(', '),
    invoiceIds: expectedIds, clientReference, emailPreview, jointBilling: true
  };
  const logEach = async (status, message, extra = {}) => {
    for (const id of expectedIds) {
      try {
        await addLog({ ...metadata, ...extra, invoiceId: id, status, message, createdAt: new Date().toISOString() });
      } catch (error) {
        console.error('[faturamento:cobranca-conjunta:log]', { invoiceId: id, message: error.message });
      }
    }
  };
  let smtpStarted = false;
  try {
    for (const id of expectedIds) {
      if (!await claim(event, id, '__company__', {
        state: 'processing', claimId, createdAt: new Date().toISOString(),
        billingEvent: billingEvents.get(id), batchId
      })) throw fail(`A fatura ${id} já participa de um envio conjunto. Confira os logs antes de repetir.`);
      claimedInvoiceIds.push(id);
    }
    const config = dependencies.emailConfig || zohoConfig();
    emailPreview.fromName = config.fromName;
    emailPreview.fromEmail = config.fromEmail;
    await (dependencies.saveDeliveryReference || store.saveDeliveryReference)(clientReference, {
      ...metadata, email: recipientKey, recipientEmails, invoiceId: batchId,
      billingEvent: event
    });
    const transport = dependencies.transport || createZohoTransport(config);
    smtpStarted = true;
    let result;
    try {
      result = await (dependencies.sendJointBillingEmail || sendJointBillingEmail)({
        recipients: preview.recipients, companyName: greetingName,
        invoiceIds: expectedIds, invoices: selectedInvoices, paymentMethod,
        totalBalance: selectedTotalBalance,
        attachments, clientReference, transport, config
      });
    } finally {
      if (!dependencies.transport && typeof transport.close === 'function') transport.close();
    }
    const partial = result.rejected.length > 0 || result.accepted.length === 0;
    let persisted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await save(event, batchId, recipientKey, {
          state: partial ? 'review' : 'sent', sentAt: new Date().toISOString(),
          messageId: result.messageId, accepted: result.accepted,
          rejected: result.rejected, invoiceIds: expectedIds
        });
        persisted = true;
        break;
      } catch (error) {
        if (attempt === 1) console.error('[faturamento:cobranca-conjunta:estado]', error);
      }
    }
    for (const id of claimedInvoiceIds) {
      try {
        await save(event, id, '__company__', {
          state: partial ? 'review' : 'sent', sentAt: new Date().toISOString(),
          billingEvent: billingEvents.get(id), batchId, messageId: result.messageId
        });
      } catch (error) {
        persisted = false;
        console.error('[faturamento:cobranca-conjunta:marcador]', { invoiceId: id, message: error.message });
      }
    }
    const status = !persisted || partial ? 'review' : 'submitted';
    await logEach(status, status === 'submitted'
      ? 'Cobrança conjunta aceita pelo SMTP; confirmação de entrega pendente.'
      : 'Resultado do envio conjunto requer conferência; não reenviar antes de verificar no provedor.',
    { messageId: result.messageId, smtpAccepted: true });
    return { status, invoiceIds: expectedIds, recipients: recipientEmails, messageId: result.messageId };
  } catch (error) {
    const code = String(error?.code || '').toUpperCase();
    const definitelyNotAccepted = !smtpStarted || error?.deliveryAccepted === false
      || ['EAUTH', 'EDNS', 'ENOTFOUND', 'ECONNREFUSED'].includes(code);
    if (definitelyNotAccepted) {
      try { await release(event, batchId, recipientKey, claimId); } catch { /* falha fechada */ }
      for (const id of claimedInvoiceIds) {
        try { await release(event, id, '__company__', claimId); } catch { /* falha fechada */ }
      }
      await logEach('error', `Cobrança conjunta não enviada${code ? ` (${code})` : ''}.`,
        { retryable: true });
      throw error;
    }
    try { await save(event, batchId, recipientKey, { state: 'review', invoiceIds: expectedIds,
      message: String(error.message).slice(0, 180) }); } catch { /* reserva permanece */ }
    for (const id of claimedInvoiceIds) {
      try { await save(event, id, '__company__', { state: 'review',
        billingEvent: billingEvents.get(id), batchId }); } catch { /* reserva permanece */ }
    }
    await logEach('review', 'Resultado SMTP incerto; confira no provedor antes de tentar novamente.');
    return { status: 'review', invoiceIds: expectedIds, recipients: recipientEmails };
  }
};

module.exports = { companyAndInvoices, previewJointBilling, sendJointBilling, jointBillingText };
