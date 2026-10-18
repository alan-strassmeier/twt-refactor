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
  saoPauloDate, billingEventForInvoice
} = require('./cobranca-processor');
const {
  zohoConfig, createZohoTransport, billingAttachments,
  jointBillingSubject, jointBillingText, sendJointBillingEmail
} = require('./cobranca-email');
const { deliveryReference } = require('./cobranca-webhook');
const store = require('./cobranca-store');

const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, expose: true });
const digits = (value) => String(value || '').replace(/\D/g, '');
const invoiceId = (value) => String(value || '').trim().replace(/^0+(?=\d)/, '');
const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
const sortIds = (values) => [...new Set(values.map(invoiceId))].sort((left, right) =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
const cents = (value) => Math.round(Number(value) * 100);

const companyAndInvoices = async (cnpjInput, dependencies = {}) => {
  const cnpj = digits(cnpjInput);
  if (cnpj.length !== 14) throw fail('Informe um CNPJ válido.', 422);
  const getCategory = dependencies.getCategory || store.getCategory;
  const fetch = dependencies.fetchInvoices || fetchInvoices;
  const category = await getCategory(cnpj);
  if (!category) throw fail('Empresa não cadastrada nos e-mails de cobrança.', 404);
  const result = await fetch({ cnpj, status: '0', limit: 100, fresh: true });
  if (result?.pagination?.allCompanyInvoicesLoaded !== true && result?.pagination?.hasMore) {
    throw fail('A consulta não retornou todas as faturas da empresa. O envio foi bloqueado.', 503);
  }
  const invoices = (result?.invoices || []).filter((invoice) =>
    digits(invoice.clientDocument) === cnpj && String(invoice.status) === '0' && isPendingInvoice(invoice));
  const unique = new Map(invoices.map((invoice) => [invoiceId(invoice.id), invoice]));
  return { cnpj, category, invoices: [...unique.values()].sort((a, b) =>
    BigInt(invoiceId(a.id)) < BigInt(invoiceId(b.id)) ? -1 : 1) };
};

const previewJointBilling = async (cnpj, dependencies = {}) => {
  const { category, invoices } = await companyAndInvoices(cnpj, dependencies);
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
      balance: Number(invoice.balance),
      blocked: Boolean(blocks.get(id)?.blocked),
      jointSent: Boolean(jointDeliveries.get(id))
    };
  });
  const recipients = (category.contacts || []).filter((contact) => contact.enabled !== false);
  return {
    company: { cnpj: category.cnpj, name: category.name, billingMethod: category.billingMethod },
    recipients: recipients.map(({ firstName, lastName, email }) => ({ firstName, lastName, email })),
    invoices: entries,
    totalBalance: Math.round(entries.reduce((sum, invoice) => sum + invoice.balance, 0) * 100) / 100,
    blockedCount: entries.filter((invoice) => invoice.blocked).length,
    jointSentCount: entries.filter((invoice) => invoice.jointSent).length
  };
};

const currentOpenInvoice = async (id, cnpj, dependencies, expectedBalance) => {
  const fetch = dependencies.fetchCurrentInvoice || fetchInvoices;
  const result = await fetch({ id, limit: 100 });
  const invoice = (result?.invoices || []).find((item) => invoiceId(item.id) === id);
  if (!invoice || digits(invoice.clientDocument) !== cnpj || String(invoice.status) !== '0'
    || !isPendingInvoice(invoice) || cents(invoice.balance) !== cents(expectedBalance)) {
    throw fail(`A fatura ${id} não está mais confirmada como aberta para esta empresa. Nenhum e-mail foi enviado.`);
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
  const preview = await previewJointBilling(cnpjInput, dependencies);
  const cnpj = preview.company.cnpj;
  const currentIds = sortIds(preview.invoices.map((invoice) => invoice.id));
  if (!sameIds(expectedIds, currentIds)) {
    throw fail('A lista de faturas em aberto mudou. Atualize a consulta antes de enviar.');
  }
  if (preview.blockedCount) throw fail('Há fatura(s) com envio bloqueado nesta empresa. Nenhum e-mail foi enviado.');
  if (preview.jointSentCount) throw fail('Há fatura(s) já reservadas ou enviadas em conjunto. Confira os logs antes de repetir.');
  if (!preview.recipients.length) throw fail('Cadastre ao menos um destinatário ativo para esta empresa.');

  const getCategory = dependencies.getCategory || store.getCategory;
  const initialCategory = await getCategory(cnpj);
  const confirmedInvoices = [];
  for (const id of expectedIds) {
    const balance = preview.invoices.find((item) => item.id === id).balance;
    confirmedInvoices.push(await currentOpenInvoice(id, cnpj, dependencies, balance));
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
  const latest = await previewJointBilling(cnpj, dependencies);
  if (!sameIds(expectedIds, sortIds(latest.invoices.map((invoice) => invoice.id)))) {
    throw fail('A lista de faturas mudou durante a preparação. Nenhum e-mail foi enviado.');
  }
  if (expectedIds.some((id) => cents(preview.invoices.find((item) => item.id === id).balance)
    !== cents(latest.invoices.find((item) => item.id === id).balance))) {
    throw fail('O saldo de uma fatura mudou durante a preparação. Atualize a consulta antes de enviar.');
  }
  if (preview.company.name !== latest.company.name
    || preview.company.billingMethod !== latest.company.billingMethod) {
    throw fail('O cadastro da empresa mudou durante a preparação. Atualize a consulta antes de enviar.');
  }
  if (latest.blockedCount) throw fail('Uma fatura foi bloqueada durante a preparação. Nenhum e-mail foi enviado.');
  if (latest.jointSentCount) throw fail('Uma fatura foi reservada por outro envio conjunto. Nenhum e-mail foi enviado.');
  const recipientEmails = preview.recipients.map((contact) => contact.email.toLowerCase()).sort();
  if (recipientEmails.join('|') !== latest.recipients.map((contact) => contact.email.toLowerCase()).sort().join('|')) {
    throw fail('Os destinatários mudaram durante a preparação. Nenhum e-mail foi enviado.');
  }
  for (const id of expectedIds) {
    await currentOpenInvoice(id, cnpj, dependencies,
      preview.invoices.find((item) => item.id === id).balance);
  }
  const today = saoPauloDate(dependencies.now ? dependencies.now() : new Date());
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
    text: jointBillingText({ companyName: greetingName, invoiceIds: expectedIds,
      paymentMethod, totalBalance: preview.totalBalance }),
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
        invoiceIds: expectedIds, paymentMethod, totalBalance: preview.totalBalance,
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
