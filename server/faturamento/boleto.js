const { createHash } = require('node:crypto');
const { normalizeInvoice } = require('./brudam');
const {
  requestExactInvoice,
  fetchCompany
} = require('./invoice-pdf');
const { findDoccobForInvoice } = require('./r2-doccob');
const { TWT_ISSUER_CNPJ, isTwtIssuer } = require('./billing-rules');
const {
  c6Config,
  createC6BankSlip,
  getC6BankSlipPdf
} = require('./c6');
const store = require('./boleto-store');

const digits = (value) => String(value || '').replace(/\D/g, '');
const firstValue = (object, keys) => {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
};

const validInvoiceId = (value) => /^\d{1,20}$/.test(String(value || '')) && Number(value) > 0;

const externalReferenceForInvoice = (invoiceId) => {
  const number = digits(invoiceId);
  const readable = `TWT${number}`;
  if (readable.length <= 10) return readable;
  return `TWT${createHash('sha256').update(number).digest('hex').slice(0, 7).toUpperCase()}`;
};

const dateOnly = (value) => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || '';
};

const validationError = (message) => Object.assign(new Error(message), { statusCode: 422 });

const payerFromCompany = (company, fallback = {}) => {
  const taxId = digits(firstValue(company, ['cnpj', 'cpf_cnpj', 'documento']) || fallback.taxId);
  const name = String(
    firstValue(company, ['razao', 'razao_social', 'nome', 'fantasia']) || fallback.name || ''
  ).trim().slice(0, 40);
  const numberText = String(firstValue(company, ['numero', 'nro']) || '').trim();
  const numberMatch = numberText.match(/\d+/);
  const number = numberMatch ? Number(numberMatch[0]) : null;
  const state = String(firstValue(company, ['uf', 'UF', 'estado']) || '').trim().toUpperCase();
  const zipCode = digits(firstValue(company, ['cep', 'CEP']));
  const city = String(firstValue(company, ['cidade', 'municipio', 'xMun']) || '').trim().slice(0, 40);
  const numberLength = number === null ? 0 : String(number).length;
  const streetLimit = Math.max(1, Math.min(33, 40 - numberLength));
  const street = String(firstValue(company, ['endereco', 'logradouro', 'xLgr']) || '')
    .trim()
    .slice(0, streetLimit);
  const complement = String(firstValue(company, ['complemento', 'xCpl']) || '').trim().slice(0, 24);
  const email = String(firstValue(company, ['email']) || '').trim().toLowerCase();

  if (![11, 14].includes(taxId.length)) throw validationError('CPF/CNPJ do pagador não está completo.');
  if (!name) throw validationError('Razão social do pagador não está preenchida.');
  if (!street || number === null || !city || !/^[A-Z]{2}$/.test(state) || zipCode.length !== 8) {
    throw validationError(
      'O cadastro do pagador precisa ter logradouro, número, cidade, UF e CEP válidos para gerar boleto.'
    );
  }

  return {
    name,
    tax_id: taxId,
    ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email: email.slice(0, 200) } : {}),
    address: {
      street,
      number,
      ...(complement ? { complement } : {}),
      city,
      state,
      zip_code: zipCode
    }
  };
};

const issuerFromInvoice = (invoice, doccob) => digits(
  doccob?.invoice?.issuerCnpj ||
  firstValue(invoice, ['cnpj_emitente', 'cnpj_empresa', 'emitente_cnpj']) ||
  invoice?.emitente?.cnpj
);

const resolveInvoiceBillingData = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const requestInvoice = dependencies.requestExactInvoice || requestExactInvoice;
  const findDoccob = dependencies.findDoccobForInvoice || findDoccobForInvoice;
  const getCompany = dependencies.fetchCompany || fetchCompany;
  const now = dependencies.now || new Date();
  const { invoice } = await requestInvoice(invoiceId);
  const normalized = normalizeInvoice(invoice);
  const normalizedInvoiceId = String(normalized.id || invoiceId);
  const clientCnpj = digits(normalized.clientDocument);

  let doccob = null;
  try {
    doccob = await findDoccob({
      invoiceId: normalizedInvoiceId,
      clientCnpj
    });
  } catch (error) {
    throw Object.assign(new Error('Não foi possível confirmar o emitente da fatura no DOCCOB.'), {
      statusCode: 503,
      expose: true,
      cause: error
    });
  }

  const issuerCnpj = issuerFromInvoice(invoice, doccob);
  if (!isTwtIssuer(issuerCnpj)) {
    throw Object.assign(new Error('Boletos C6 são permitidos somente para faturas emitidas pela TWT.'), {
      statusCode: 403
    });
  }
  if (normalized.status === 1) throw validationError('A fatura já está liquidada.');
  if (normalized.status === 2) throw validationError('Não é possível gerar boleto para uma fatura cancelada.');

  const amount = Number(normalized.balance ?? normalized.total);
  if (!Number.isFinite(amount) || amount <= 0) throw validationError('A fatura não possui saldo pendente válido.');
  const dueAt = dateOnly(normalized.dueAt || doccob?.invoice?.dueAt);
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )).toISOString().slice(0, 10);
  if (!dueAt) throw validationError('A fatura não possui data de vencimento válida.');
  if (dueAt < today) {
    throw validationError('O vencimento da fatura já passou. Atualize o vencimento na Brudam antes de gerar o boleto.');
  }
  if (clientCnpj.length !== 14) throw validationError('CNPJ do cliente não está completo.');

  const company = await getCompany(clientCnpj);
  if (!company) throw validationError('Cadastro do pagador não encontrado na Brudam.');

  return {
    invoiceId: normalizedInvoiceId,
    issuerCnpj,
    amount: Number(amount.toFixed(2)),
    dueAt,
    payer: payerFromCompany(company, {
      taxId: clientCnpj,
      name: normalized.client
    })
  };
};

const bankSlipPayload = (billing, config) => ({
  external_reference_id: externalReferenceForInvoice(billing.invoiceId),
  amount: billing.amount,
  due_date: billing.dueAt,
  instructions: [`Fatura ${billing.invoiceId} - TWT Airpack`],
  billing_scheme: config.billingScheme,
  payer: billing.payer
});

const publicRecord = (record, created = false) => ({
  invoiceId: record.invoiceId,
  status: record.state,
  created,
  amount: record.amount,
  dueAt: record.dueAt,
  digitableLine: record.digitableLine || '',
  barCode: record.barCode || ''
});

const generationConflict = (state) => Object.assign(
  new Error(state === 'review'
    ? 'A tentativa anterior precisa de conferência antes de gerar outro boleto.'
    : 'A geração deste boleto já está em andamento.'),
  { statusCode: 409 }
);

const generateInvoiceBankSlip = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const getRecord = dependencies.getBankSlipRecord || store.getBankSlipRecord;
  const claim = dependencies.claimBankSlip || store.claimBankSlip;
  const save = dependencies.saveBankSlipRecord || store.saveBankSlipRecord;
  const release = dependencies.releaseBankSlipClaim || store.releaseBankSlipClaim;
  const create = dependencies.createC6BankSlip || createC6BankSlip;
  const getConfig = dependencies.c6Config || c6Config;
  const now = dependencies.now || new Date();
  const normalizedInvoiceId = String(invoiceId);
  const existing = await getRecord(normalizedInvoiceId);
  if (existing?.state === 'ready') return publicRecord(existing, false);
  if (existing?.state === 'processing' || existing?.state === 'review') {
    throw generationConflict(existing.state);
  }

  const billing = await resolveInvoiceBillingData(normalizedInvoiceId, dependencies);
  const config = getConfig();
  const processingRecord = {
    state: 'processing',
    invoiceId: billing.invoiceId,
    issuerCnpj: TWT_ISSUER_CNPJ,
    startedAt: now.toISOString()
  };
  const claimed = await claim(billing.invoiceId, processingRecord);
  if (!claimed) {
    const concurrent = await getRecord(billing.invoiceId);
    if (concurrent?.state === 'ready') return publicRecord(concurrent, false);
    throw generationConflict(concurrent?.state);
  }

  let bankResponse = null;
  try {
    const payload = bankSlipPayload(billing, config);
    bankResponse = await create(payload, { config });
    const bankSlipId = String(bankResponse?.id || '').trim();
    if (!bankSlipId) {
      throw Object.assign(new Error('O C6 não retornou o identificador do boleto.'), {
        statusCode: 502,
        receivedResponse: true,
        ambiguousBankState: true
      });
    }
    const readyRecord = {
      state: 'ready',
      invoiceId: billing.invoiceId,
      issuerCnpj: billing.issuerCnpj,
      bankSlipId,
      externalReferenceId: payload.external_reference_id,
      amount: Number(bankResponse.amount ?? billing.amount),
      dueAt: dateOnly(bankResponse.due_date) || billing.dueAt,
      digitableLine: String(bankResponse.digitable_line || ''),
      barCode: String(bankResponse.bar_code || ''),
      createdAt: now.toISOString()
    };
    await save(billing.invoiceId, readyRecord);
    return publicRecord(readyRecord, true);
  } catch (error) {
    if (bankResponse || error.ambiguousBankState) {
      const reviewRecord = {
        ...processingRecord,
        state: 'review',
        reviewedAt: now.toISOString()
      };
      try { await save(billing.invoiceId, reviewRecord); } catch { /* mantém o lock original */ }
    } else {
      try { await release(billing.invoiceId); } catch { /* o lock expira em 24 horas */ }
    }
    throw error;
  }
};

const getInvoiceBankSlipPdf = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const getRecord = dependencies.getBankSlipRecord || store.getBankSlipRecord;
  const download = dependencies.getC6BankSlipPdf || getC6BankSlipPdf;
  const record = await getRecord(String(invoiceId));
  if (!record || record.state !== 'ready' || !record.bankSlipId) {
    throw Object.assign(new Error('Nenhum boleto foi gerado para esta fatura.'), { statusCode: 404 });
  }
  const config = (dependencies.c6Config || c6Config)();
  return download(record.bankSlipId, { config });
};

module.exports = {
  externalReferenceForInvoice,
  payerFromCompany,
  issuerFromInvoice,
  resolveInvoiceBillingData,
  bankSlipPayload,
  generateInvoiceBankSlip,
  getInvoiceBankSlipPdf
};
