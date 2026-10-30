const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
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
const { savePreparedPackage, loadPreparedPackage } = require('./cobranca-conjunta-cache');

const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const MAX_INVOICES_PER_EMAIL = 10;
const INVOICE_CHECK_CONCURRENCY = 3;
const EMPTY_INVOICE_RETRIES = 3;
const PREVIEW_PROOF_TTL_MS = 30 * 60 * 1000;
const MAX_INVOICE_SNAPSHOT_CHARS = 500000;
const WRITE_BATCH_SIZE = 4;
const forEachBatch = async (items, callback) => {
  for (let index = 0; index < items.length; index += WRITE_BATCH_SIZE) {
    await Promise.all(items.slice(index, index + WRITE_BATCH_SIZE).map(callback));
  }
};
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, expose: true });
const refreshFailure = (id, message) => Object.assign(fail(message, 409), {
  invoiceId: id, retryable: true, retryStage: 'refresh'
});
const digits = (value) => String(value || '').replace(/\D/g, '');
const invoiceId = (value) => String(value || '').trim().replace(/^0+(?=\d)/, '');
const sortIds = (values) => [...new Set(values.map(invoiceId))].sort((left, right) =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
const overdueDays = (dueAt, today) => Math.floor((Date.parse(`${today}T00:00:00Z`)
  - Date.parse(`${String(dueAt || '').slice(0, 10)}T00:00:00Z`)) / 86400000);
const isOverdue = (invoice, today) =>
  automaticBillingEventForInvoice(invoice, today) === EVENT_TYPES.overdue;
const blockKind = (block) => !block?.blocked ? ''
  : block.reason === 'bank_reconciliation' ? 'bank_reconciliation' : 'manual';
const blockDescription = (kind) => kind === 'manual' ? 'bloqueio manual'
  : kind === 'bank_reconciliation' ? 'pendência de conciliação bancária' : '';
const previewSecret = (dependencies) => String(
  dependencies.previewSecret || process.env.FATURAMENTO_SESSION_SECRET || ''
);
const previewNow = (dependencies) => (dependencies.now ? dependencies.now() : new Date()).getTime();
const proofSignature = (payload, secret) =>
  createHmac('sha256', secret).update(payload).digest('base64url');
const invoiceProof = (invoice, cnpj, dependencies) => {
  const secret = previewSecret(dependencies);
  if (secret.length < 32) throw fail('Assinatura da prévia de cobrança não configurada.', 503);
  const payload = Buffer.from(JSON.stringify({
    v: 1, id: invoiceId(invoice.id), cnpj,
    issuedAt: String(invoice.issuedAt || '').slice(0, 10),
    dueAt: String(invoice.dueAt || '').slice(0, 10),
    balance: Number(invoice.balance), checkedAt: previewNow(dependencies)
  })).toString('base64url');
  return `${payload}.${proofSignature(payload, secret)}`;
};
const invoiceFromProof = (proof, id, cnpj, dependencies) => {
  const secret = previewSecret(dependencies);
  if (secret.length < 32) throw fail('Assinatura da prévia de cobrança não configurada.', 503);
  const [payload, signature, extra] = String(proof || '').split('.');
  const expected = payload ? proofSignature(payload, secret) : '';
  if (!payload || !signature || extra || payload.length > 2048
    || signature.length !== expected.length
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw refreshFailure(id, `A confirmação da fatura ${id} é inválida. Atualize a prévia antes de enviar.`);
  }
  let verified;
  try {
    verified = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw refreshFailure(id, `A confirmação da fatura ${id} é inválida. Atualize a prévia antes de enviar.`);
  }
  const now = previewNow(dependencies);
  if (verified?.v !== 1 || verified.id !== id || verified.cnpj !== cnpj
    || !Number.isFinite(verified.balance) || verified.balance <= 0
    || (verified.issuedAt !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(verified.issuedAt))
    || !/^\d{4}-\d{2}-\d{2}$/.test(verified.dueAt)
    || !Number.isFinite(verified.checkedAt) || verified.checkedAt > now + 60000
    || now - verified.checkedAt > PREVIEW_PROOF_TTL_MS) {
    throw refreshFailure(id,
      `A confirmação da fatura ${id} expirou ou não corresponde à empresa. Atualize a prévia antes de enviar.`);
  }
  return { id, clientDocument: cnpj, status: '0', issuedAt: verified.issuedAt,
    dueAt: verified.dueAt, balance: verified.balance };
};

const invoiceSnapshot = (data, proof, dependencies) => {
  const raw = Buffer.from(JSON.stringify(data));
  if (raw.length > 4 * 1024 * 1024) {
    throw fail('Os dados desta fatura são grandes demais para manter na prévia. Nenhum e-mail foi enviado.', 413);
  }
  const payload = gzipSync(raw).toString('base64url');
  if (payload.length > MAX_INVOICE_SNAPSHOT_CHARS) {
    throw fail('Os dados desta fatura são grandes demais para manter na prévia. Nenhum e-mail foi enviado.', 413);
  }
  return `${payload}.${proofSignature(`${proof}.${payload}`, previewSecret(dependencies))}`;
};

const invoiceDataFromSnapshot = (snapshot, proof, id, cnpj, dependencies) => {
  const [payload, signature, extra] = String(snapshot || '').split('.');
  const expected = payload ? proofSignature(`${proof}.${payload}`, previewSecret(dependencies)) : '';
  if (!payload || payload.length > MAX_INVOICE_SNAPSHOT_CHARS || !signature || extra
    || signature.length !== expected.length
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw refreshFailure(id,
      `Os dados guardados da fatura ${id} são inválidos. Tente novamente apenas esta fatura.`);
  }
  let data;
  try {
    data = JSON.parse(gunzipSync(Buffer.from(payload, 'base64url'), {
      maxOutputLength: 4 * 1024 * 1024
    }).toString('utf8'));
  } catch {
    throw refreshFailure(id,
      `Não foi possível ler os dados guardados da fatura ${id}. Tente novamente apenas esta fatura.`);
  }
  if (invoiceId(data?.invoice?.id) !== id || digits(data?.client?.document) !== cnpj) {
    throw refreshFailure(id,
      `Os dados guardados da fatura ${id} não correspondem à empresa. Nenhum e-mail foi enviado.`);
  }
  return data;
};

const fetchExactInvoice = async (id, dependencies = {}) => {
  const fetch = dependencies.fetchCurrentInvoice || dependencies.fetchInvoices || fetchInvoices;
  const wait = dependencies.waitBeforeInvoiceRetry || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const retryDeadline = Date.now() + 12000;
  for (let attempt = 1; attempt <= EMPTY_INVOICE_RETRIES; attempt += 1) {
    let result;
    try {
      result = await retryTransientNetworkRequest(() => fetch({ id, limit: 100, fresh: true }));
    } catch (error) {
      const status = Number(error?.statusCode || error?.upstreamStatus || 0);
      if (status >= 500 && attempt < EMPTY_INVOICE_RETRIES && Date.now() < retryDeadline) {
        await wait(200 * attempt);
        continue;
      }
      console.warn('[faturamento:cobranca-conjunta:consulta-fatura]', {
        invoiceId: id,
        httpStatus: status || null,
        code: String(error?.code || error?.name || '').slice(0, 40)
      });
      throw Object.assign(fail(
        `Não foi possível confirmar a situação da fatura ${id} na Brudam${status ? ` (HTTP ${status})` : ''}. Nenhum e-mail foi enviado.`, 503
      ), { cause: error });
    }
    const matches = (result?.invoices || []).filter((item) => invoiceId(item.id) === id);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw fail(`A Brudam retornou registros duplicados para a fatura ${id}. Nenhum e-mail foi enviado.`, 503);
    }
    if (attempt === EMPTY_INVOICE_RETRIES || Date.now() >= retryDeadline) {
      throw fail(
        `A Brudam não retornou uma situação financeira inequívoca para a fatura ${id} após ${attempt} consulta(s). Nenhum e-mail foi enviado.`, 503
      );
    }
    await wait(200 * attempt);
  }
};

const companyCandidates = async (cnpjInput, dependencies = {}, onlyInvoiceIds = null) => {
  const cnpj = digits(cnpjInput);
  if (cnpj.length !== 14) throw fail('Informe um CNPJ válido.', 422);
  const getCategory = dependencies.getCategory || store.getCategory;
  const fetch = dependencies.fetchInvoices || fetchInvoices;
  const category = await getCategory(cnpj);
  if (!category) throw fail('Empresa não cadastrada nos e-mails de cobrança.', 404);
  const today = saoPauloDate(dependencies.now ? dependencies.now() : new Date());
  let result;
  try {
    result = await fetch({ cnpj, status: '0', 'vencimento[lte]': addDays(today, -2),
      limit: 100, fresh: true });
  } catch (error) {
    const status = Number(error?.statusCode || error?.upstreamStatus || 0);
    throw Object.assign(fail(status === 429
      ? 'A Brudam limitou a consulta inicial (HTTP 429). Aguarde um instante e busque a empresa novamente.'
      : `Não foi possível listar as faturas na Brudam${status ? ` (HTTP ${status})` : ''}: ${String(error.message || 'erro desconhecido').slice(0, 180)}`, 503),
    { cause: error });
  }
  if (result?.pagination?.allCompanyInvoicesLoaded !== true && result?.pagination?.hasMore) {
    throw fail('A consulta não retornou todas as faturas da empresa. O envio foi bloqueado.', 503);
  }
  const candidates = (result?.invoices || []).filter((invoice) =>
    digits(invoice.clientDocument) === cnpj && String(invoice.status) === '0'
    && isPendingInvoice(invoice) && isOverdue(invoice, today));
  const candidatesById = new Map(candidates.map((invoice) => [invoiceId(invoice.id), invoice]));
  const candidateEntries = [...candidatesById.entries()]
    .filter(([id]) => !onlyInvoiceIds || onlyInvoiceIds.has(id));
  return { cnpj, category, today, candidateEntries };
};

const listJointBilling = async (cnpjInput, dependencies = {}) => {
  const { cnpj, category, today, candidateEntries } = await companyCandidates(cnpjInput, dependencies);
  const ids = candidateEntries.map(([id]) => id);
  const [blocks, jointDeliveries] = await Promise.all([
    (dependencies.getInvoiceBlocks || store.getInvoiceBlocks)(ids),
    (dependencies.getJointDeliveries || store.getJointDeliveries)(ids)
  ]);
  const entries = candidateEntries.map(([id, invoice]) => {
    const block = blocks.get(id);
    const kind = blockKind(block);
    return {
      id, issuedAt: invoice.issuedAt, dueAt: invoice.dueAt,
      balance: null, overdueDays: overdueDays(invoice.dueAt, today),
      unverified: true, blocked: true, blockKind: kind,
      blockReason: [
        'Aguardando conferência individual da fatura na Brudam.',
        blockDescription(kind)
      ].filter(Boolean).join(' · '),
      jointSent: Boolean(jointDeliveries.get(id)), proof: null
    };
  });
  const recipients = (category.contacts || []).filter((contact) => contact.enabled !== false);
  return {
    company: { cnpj, name: category.name, billingMethod: category.billingMethod },
    recipients: recipients.map(({ firstName, lastName, email }) => ({ firstName, lastName, email })),
    invoices: entries, totalBalance: 0, blockedCount: entries.length,
    jointSentCount: entries.filter((invoice) => invoice.jointSent).length
  };
};

const companyAndInvoices = async (cnpjInput, dependencies = {}, onlyInvoiceIds = null) => {
  const { cnpj, category, today, candidateEntries } =
    await companyCandidates(cnpjInput, dependencies, onlyInvoiceIds);
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
      if (isOverdue(current, today)) checked[index] = {
        ...current, issuedAt: current.issuedAt || listed.issuedAt
      };
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
    const block = blocks.get(id);
    const kind = blockKind(block);
    const blocked = Boolean(invoice.unverified || block?.blocked);
    const jointSent = Boolean(jointDeliveries.get(id));
    return {
      id: invoiceId(invoice.id),
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      balance: invoice.unverified ? null : Number(invoice.balance),
      overdueDays: overdueDays(invoice.dueAt, today),
      unverified: Boolean(invoice.unverified),
      blocked,
      blockKind: kind,
      blockReason: [invoice.blockReason, blockDescription(kind)].filter(Boolean).join(' · '),
      jointSent,
      proof: !blocked && !jointSent ? invoiceProof(invoice, digits(category.cnpj), dependencies) : null
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

const refreshJointBillingInvoice = async ({ cnpj: cnpjInput, invoiceId: requestedId,
  includePdfData = false }, dependencies = {}) => {
  const cnpj = digits(cnpjInput);
  const id = invoiceId(requestedId);
  if (cnpj.length !== 14 || !/^\d{1,20}$/.test(String(requestedId || '')) || !/^\d+$/.test(id)
    || BigInt(id) === 0n) {
    throw fail('Informe uma empresa e uma fatura válidas para atualizar.', 422);
  }
  const getCategory = dependencies.getCategory || store.getCategory;
  const category = await getCategory(cnpj);
  if (!category) throw fail('Empresa não cadastrada nos e-mails de cobrança.', 404);
  const today = saoPauloDate(dependencies.now ? dependencies.now() : new Date());
  const blocks = await (dependencies.getInvoiceBlocks || store.getInvoiceBlocks)([id]);
  const kind = blockKind(blocks.get(id));
  let current;
  let pdfData = null;
  try {
    if (includePdfData === true) {
      pdfData = await (dependencies.fetchInvoicePdfData || fetchInvoicePdfData)(id);
      current = {
        ...pdfData.invoice,
        clientDocument: pdfData.client?.document
      };
      if (invoiceId(current.id) !== id) {
        throw fail(`A Brudam retornou dados de outra fatura para ${id}.`, 503);
      }
    } else {
      current = await fetchExactInvoice(id, dependencies);
    }
  } catch (error) {
    const upstreamStatus = Number(error?.upstreamStatus || error?.cause?.upstreamStatus
      || error?.cause?.statusCode || error?.statusCode || 0);
    return { id, removed: false, invoice: {
      id, balance: null, unverified: true, blocked: true, proof: null,
      upstreamStatus: upstreamStatus || null, blockKind: kind,
      blockReason: [error.message.replace(/\s*Nenhum e-mail foi enviado\.\s*$/, ''),
        blockDescription(kind)].filter(Boolean).join(' · ')
    } };
  }
  if (digits(current.clientDocument) !== cnpj) {
    return { id, removed: false, invoice: {
      id, balance: null, unverified: true, blocked: true, proof: null,
      upstreamStatus: null, blockKind: kind,
      blockReason: [`O cliente da fatura ${id} não pôde ser confirmado na Brudam.`,
        blockDescription(kind)].filter(Boolean).join(' · ')
    } };
  }
  if (!['0', '1', '2'].includes(String(current.status))
    || current.balance === null || current.balance === undefined
    || !Number.isFinite(Number(current.balance))) {
    return { id, removed: false, invoice: {
      id, balance: null, unverified: true, blocked: true, proof: null,
      upstreamStatus: null, blockKind: kind,
      blockReason: [`A Brudam não retornou uma situação financeira completa para a fatura ${id}.`,
        blockDescription(kind)].filter(Boolean).join(' · ')
    } };
  }
  if (String(current.status) !== '0' || !isPendingInvoice(current) || !isOverdue(current, today)) {
    return { id, removed: true };
  }
  const jointDeliveries = await (dependencies.getJointDeliveries || store.getJointDeliveries)([id]);
  const blocked = Boolean(blocks.get(id)?.blocked);
  const jointSent = Boolean(jointDeliveries.get(id));
  const proof = !blocked && !jointSent ? invoiceProof(current, cnpj, dependencies) : null;
  return { id, removed: false, invoice: {
    id, issuedAt: current.issuedAt, dueAt: current.dueAt,
    balance: Number(current.balance), overdueDays: overdueDays(current.dueAt, today),
    unverified: false, upstreamStatus: null, blocked,
    blockKind: kind, blockReason: blockDescription(kind),
    jointSent, proof,
    snapshot: proof && pdfData ? invoiceSnapshot(pdfData, proof, dependencies) : null
  } };
};

const prepareAttachments = async (invoice, category, dependencies, preparedData = null) => {
  const id = invoiceId(invoice.id);
  const findDoccob = dependencies.findDoccobForInvoice || findDoccobForInvoice;
  const doccob = await findDoccob({ invoiceId: id, clientCnpj: category.cnpj, issuedAt: invoice.issuedAt });
  if (!doccob) throw fail(`DOCCOB da fatura ${id} não localizado. Nenhum e-mail foi enviado.`);
  const fetchPdfData = dependencies.fetchInvoicePdfData || fetchInvoicePdfData;
  const data = applyCategoryBillingMethod(preparedData || await fetchPdfData(id), category);
  if (digits(data.client?.document) !== digits(category.cnpj) || invoiceId(data.invoice?.id) !== id) {
    throw fail(`Os documentos da fatura ${id} não correspondem à empresa selecionada. Nenhum e-mail foi enviado.`);
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

const prepareJointBillingInvoice = async ({ cnpj: cnpjInput, invoiceId: requestedId,
  proof, snapshot }, dependencies = {}) => {
  const cnpj = digits(cnpjInput);
  const id = invoiceId(requestedId);
  if (cnpj.length !== 14 || !/^\d{1,20}$/.test(String(requestedId || '')) || id === '0') {
    throw fail('Informe uma empresa e uma fatura válidas para preparar os anexos.', 422);
  }
  const invoice = invoiceFromProof(proof, id, cnpj, dependencies);
  const data = invoiceDataFromSnapshot(snapshot, proof, id, cnpj, dependencies);
  const category = await (dependencies.getCategory || store.getCategory)(cnpj);
  if (!category) throw fail('Empresa não cadastrada nos e-mails de cobrança.', 404);
  try {
    const attachments = await prepareAttachments(invoice, category, dependencies, data);
    const saved = await (dependencies.savePreparedPackage || savePreparedPackage)({
      cnpj, invoiceId: id, proof, attachments
    }, { secret: previewSecret(dependencies), now: dependencies.now });
    return { id, ...saved };
  } catch (error) {
    const status = Number(error?.upstreamStatus || error?.statusCode || 0);
    const reason = status === 429 ? 'A Brudam limitou a consulta dos documentos (HTTP 429).'
      : String(error?.message || 'Falha desconhecida ao preparar os documentos.').slice(0, 220);
    const permanent = [409, 413, 422].includes(status) || error?.retryable === false;
    throw Object.assign(fail(`Fatura ${id}: ${reason} Nenhum e-mail foi enviado.`,
      status === 429 ? 429 : permanent && status ? status : 503), {
      invoiceId: id, upstreamStatus: status || null, retryable: !permanent,
      retryStage: error?.retryStage || 'prepare', cause: error
    });
  }
};

const sendJointBilling = async ({ cnpj: cnpjInput, invoiceIds, invoiceProofs,
  invoiceSnapshots, invoicePackages }, dependencies = {}) => {
  const expectedIds = Array.isArray(invoiceIds) && invoiceIds.length > 0
    && invoiceIds.every((id) => /^\d{1,20}$/.test(String(id)) && Number(id) > 0)
    ? sortIds(invoiceIds) : null;
  if (!expectedIds || expectedIds.length !== invoiceIds.length) {
    throw fail('Confira a lista de faturas antes de enviar.', 422);
  }
  if (expectedIds.length > MAX_INVOICES_PER_EMAIL) {
    throw fail(`Cada e-mail pode conter no máximo ${MAX_INVOICES_PER_EMAIL} faturas. Divida o envio em grupos menores.`, 413);
  }
  const cnpj = digits(cnpjInput);
  if (cnpj.length !== 14) throw fail('Informe um CNPJ válido.', 422);
  const proofById = new Map(Array.isArray(invoiceProofs)
    ? invoiceProofs.map((item) => [invoiceId(item?.id), item?.proof]) : []);
  if (!Array.isArray(invoiceProofs) || proofById.size !== expectedIds.length
    || invoiceProofs.length !== expectedIds.length) {
    throw fail('A liberação das faturas está incompleta. Atualize a prévia antes de enviar.', 409);
  }
  const selected = expectedIds.map((id) => invoiceFromProof(proofById.get(id), id, cnpj, dependencies));
  const snapshotById = new Map(Array.isArray(invoiceSnapshots)
    ? invoiceSnapshots.map((item) => [invoiceId(item?.id), item?.snapshot]) : []);
  if (invoiceSnapshots !== undefined && (!Array.isArray(invoiceSnapshots)
    || snapshotById.size !== expectedIds.length
    || invoiceSnapshots.length !== expectedIds.length)) {
    throw fail('Os dados das faturas estão incompletos. Tente novamente as que falharam.', 409);
  }
  const getCategory = dependencies.getCategory || store.getCategory;
  const initialCategory = await getCategory(cnpj);
  if (!initialCategory) throw fail('Empresa não cadastrada nos e-mails de cobrança.', 404);
  const recipients = (initialCategory.contacts || []).filter((contact) => contact.enabled !== false)
    .map(({ firstName, lastName, email }) => ({ firstName, lastName, email }));
  if (!recipients.length) throw fail('Cadastre ao menos um destinatário ativo para esta empresa.');
  const preview = {
    company: { cnpj, name: initialCategory.name, billingMethod: initialCategory.billingMethod },
    recipients
  };
  let attachments = [];
  if (invoicePackages !== undefined) {
    const packageById = new Map(Array.isArray(invoicePackages)
      ? invoicePackages.map((item) => [invoiceId(item?.id), item?.token]) : []);
    if (!Array.isArray(invoicePackages) || packageById.size !== expectedIds.length
      || invoicePackages.length !== expectedIds.length) {
      throw fail('Os anexos preparados estão incompletos. Tente novamente apenas as faturas com erro.', 409);
    }
    for (let offset = 0; offset < expectedIds.length; offset += 4) {
      const group = await Promise.all(expectedIds.slice(offset, offset + 4).map(async (id) => {
        try {
          return await (dependencies.loadPreparedPackage || loadPreparedPackage)({
            token: packageById.get(id), cnpj, invoiceId: id, proof: proofById.get(id)
          }, { secret: previewSecret(dependencies), now: dependencies.now });
        } catch (error) {
          throw Object.assign(fail(`Fatura ${id}: ${error.message} Nenhum e-mail foi enviado.`, 409), {
            invoiceId: id, retryable: true, retryStage: 'prepare', cause: error
          });
        }
      }));
      for (const invoiceAttachments of group) attachments.push(...invoiceAttachments);
      if (attachments.reduce((sum, item) => sum + item.content.length, 0) > MAX_ATTACHMENT_BYTES) {
        throw fail('Os anexos ultrapassam 18 MB. Ignore algumas faturas neste envio.', 413);
      }
    }
  } else {
    // Mantido para chamadas internas antigas; a rota pública exige anexos preparados.
    for (const invoice of selected) {
      const id = invoiceId(invoice.id);
      try {
        const preparedData = invoiceSnapshots === undefined ? null
          : invoiceDataFromSnapshot(snapshotById.get(id), proofById.get(id), id, cnpj, dependencies);
        attachments.push(...await prepareAttachments(invoice, initialCategory, dependencies, preparedData));
      } catch (error) {
        const upstreamStatus = Number(error?.upstreamStatus || error?.statusCode || 0);
        const reason = upstreamStatus === 429
          ? 'A Brudam limitou a consulta dos documentos (HTTP 429).'
          : String(error?.message || 'Falha desconhecida ao preparar os documentos.').slice(0, 220);
        throw Object.assign(fail(`Fatura ${id}: ${reason} Nenhum e-mail foi enviado.`,
          error?.statusCode === 409 ? 409 : upstreamStatus === 429 ? 429 : 503), {
          invoiceId: id, upstreamStatus: upstreamStatus || null, retryable: true, cause: error
        });
      }
    }
  }
  if (attachments.reduce((sum, item) => sum + item.content.length, 0) > MAX_ATTACHMENT_BYTES) {
    throw fail('Os anexos ultrapassam 18 MB. Nenhum e-mail foi enviado.', 413);
  }

  const recipientEmails = preview.recipients.map((contact) => contact.email.toLowerCase()).sort();
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
  const billingEvents = new Map(selected.map((invoice) => [invoiceId(invoice.id),
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
    await forEachBatch(expectedIds, async (id) => {
      try {
        await addLog({ ...metadata, ...extra, invoiceId: id, status, message, createdAt: new Date().toISOString() });
      } catch (error) {
        console.error('[faturamento:cobranca-conjunta:log]', { invoiceId: id, message: error.message });
      }
    });
  };
  let smtpStarted = false;
  try {
    for (let index = 0; index < expectedIds.length; index += WRITE_BATCH_SIZE) {
      const ids = expectedIds.slice(index, index + WRITE_BATCH_SIZE);
      const results = await Promise.allSettled(ids.map((id) => claim(event, id, '__company__', {
        state: 'processing', claimId, createdAt: new Date().toISOString(),
        billingEvent: billingEvents.get(id), batchId
      })));
      let failure = null;
      results.forEach((result, offset) => {
        if (result.status === 'fulfilled' && result.value) claimedInvoiceIds.push(ids[offset]);
        else failure ||= result.status === 'rejected' ? result.reason
          : fail(`A fatura ${ids[offset]} já participa de um envio conjunto. Confira os logs antes de repetir.`);
      });
      if (failure) throw failure;
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
    await forEachBatch(claimedInvoiceIds, async (id) => {
      try {
        await save(event, id, '__company__', {
          state: partial ? 'review' : 'sent', sentAt: new Date().toISOString(),
          billingEvent: billingEvents.get(id), batchId, messageId: result.messageId
        });
      } catch (error) {
        persisted = false;
        console.error('[faturamento:cobranca-conjunta:marcador]', { invoiceId: id, message: error.message });
      }
    });
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
    console.error('[faturamento:cobranca-conjunta:envio]', {
      invoiceCount: expectedIds.length,
      attachmentBytes: attachments.reduce((sum, item) => sum + item.content.length, 0),
      smtpStarted,
      definitelyNotAccepted,
      code: code.slice(0, 32),
      responseCode: Number(error?.responseCode) || null,
      command: String(error?.command || '').slice(0, 32)
    });
    if (definitelyNotAccepted) {
      try { await release(event, batchId, recipientKey, claimId); } catch { /* falha fechada */ }
      await forEachBatch(claimedInvoiceIds, async (id) => {
        try { await release(event, id, '__company__', claimId); } catch { /* falha fechada */ }
      });
      await logEach('error', `Cobrança conjunta não enviada${code ? ` (${code})` : ''}.`,
        { retryable: true });
      throw error;
    }
    try { await save(event, batchId, recipientKey, { state: 'review', invoiceIds: expectedIds,
      message: String(error.message).slice(0, 180) }); } catch { /* reserva permanece */ }
    await forEachBatch(claimedInvoiceIds, async (id) => {
      try { await save(event, id, '__company__', { state: 'review',
        billingEvent: billingEvents.get(id), batchId }); } catch { /* reserva permanece */ }
    });
    await logEach('review', 'Resultado SMTP incerto; confira no provedor antes de tentar novamente.');
    return { status: 'review', invoiceIds: expectedIds, recipients: recipientEmails };
  }
};

const confirmJointDelivery = async ({ clientReference, confirmAllRecipients }, dependencies = {}) => {
  const referenceId = String(clientReference || '').trim();
  if (!/^twt-joint-[a-z0-9-]{20,120}$/i.test(referenceId) || confirmAllRecipients !== true) {
    throw fail('Confirme a entrega a todos os destinatários usando a referência do envio conjunto.', 400);
  }
  const reference = await (dependencies.getDeliveryReference || store.getDeliveryReference)(referenceId);
  const ids = reference?.invoiceIds;
  const recipients = reference?.recipientEmails;
  if (!reference?.jointBilling || reference.event !== 'joint'
    || reference.clientReference !== referenceId || !Array.isArray(ids) || !ids.length
    || !Array.isArray(recipients) || !recipients.length) {
    throw fail('Envio conjunto não localizado para esta referência.', 404);
  }
  const get = dependencies.getDelivery || store.getDelivery;
  const save = dependencies.saveDelivery || store.saveDelivery;
  const addLog = dependencies.addLog || store.addLog;
  const batch = await get('joint', reference.invoiceId, reference.email);
  if (!batch) throw fail('Reserva do envio conjunto não localizada. Nenhum estado foi alterado.', 409);
  if (batch.state === 'delivered') return { status: 'delivered', invoiceIds: ids, alreadyConfirmed: true };
  if (!['review', 'sent'].includes(batch.state)
    || Object.values(batch.recipientEvents || {}).some((entry) =>
      ['soft_bounce', 'hard_bounce', 'bounced'].includes(entry?.status))) {
    throw fail('Há evento incompatível com a entrega completa; confira o histórico no provedor.', 409);
  }
  const invoiceRecords = new Map();
  await forEachBatch(ids, async (id) => {
    const record = await get('joint', id, '__company__');
    if (!record || String(record.batchId) !== String(reference.invoiceId)
      || !['review', 'sent', 'delivered'].includes(record.state)) {
      throw fail(`A reserva da fatura ${id} não corresponde ao envio confirmado. Nenhum estado foi alterado.`, 409);
    }
    invoiceRecords.set(id, record);
  });
  const confirmedAt = (dependencies.now ? dependencies.now() : new Date()).toISOString();
  await forEachBatch(ids, (id) => save('joint', id, '__company__', {
    ...invoiceRecords.get(id), state: 'delivered', manuallyConfirmedAt: confirmedAt,
    confirmationSource: 'provider_panel'
  }));
  await save('joint', reference.invoiceId, reference.email, {
    ...batch, state: 'delivered', manuallyConfirmedAt: confirmedAt,
    confirmationSource: 'provider_panel'
  });
  await forEachBatch(ids, (id) => addLog({
    ...reference, id: randomUUID(), invoiceId: id, createdAt: confirmedAt,
    email: recipients.join(', '), status: 'delivered', manuallyConfirmedAt: confirmedAt,
    confirmationSource: 'provider_panel',
    message: `Entrega aos ${recipients.length} destinatário(s) confirmada manualmente no painel do provedor; nenhum e-mail foi reenviado.`
  }));
  return { status: 'delivered', invoiceIds: ids, recipients: recipients.length };
};

module.exports = {
  companyAndInvoices, listJointBilling, previewJointBilling,
  refreshJointBillingInvoice, prepareJointBillingInvoice, sendJointBilling,
  confirmJointDelivery, jointBillingText
};
