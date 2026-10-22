const {
  queryItauBankSlipDetail,
  normalizeItauBankSlip,
  itauAmount,
  itauBoletoConfig
} = require('./itau');
const {
  listBradescoSettledBankSlips,
  bradescoConfig
} = require('./bradesco');
const { fetchInvoices, authenticatedPost } = require('./brudam');
const bankSlipStore = require('./boleto-store');
const billingStore = require('./cobranca-store');

const BILLING_EVENTS = ['initial', 'reminder', 'overdue'];
const BANKS = new Set(['itau', 'bradesco']);
// Recuperação pontual da tentativa feita com o número da conta em vez do ID Brudam.
const ITAU_MANUAL_RETRY_INVOICE_ID = '11838';
const ITAU_MANUAL_RETRY_BANK_ACCOUNT_ID = 6;

const digits = (value) => String(value || '').replace(/\D/g, '');
const sameOurNumber = (left, right) => {
  const first = digits(left);
  const second = digits(right);
  return Boolean(first && second && /[1-9]/.test(first) && /[1-9]/.test(second)) &&
    first.replace(/^0+/, '') === second.replace(/^0+/, '');
};
const cents = (value) => Math.round(Number(value || 0) * 100);

const validIsoDate = (value) => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
};

const addDays = (date, amount) => {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
};

const positiveInteger = (value, label) => {
  const text = String(value ?? '').trim();
  const number = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw Object.assign(new Error(`${label} deve ser um número inteiro maior que zero.`), {
      statusCode: 503,
      expose: true
    });
  }
  return number;
};

const brudamLiquidationSettings = (bank, env = process.env) => {
  if (!BANKS.has(bank)) throw new Error('Banco não suportado para conciliação.');
  // conta_bancaria usa o valor interno da opção na Brudam, não agência/conta exibidas.
  return {
    paymentMethodId: positiveInteger(
      env.BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID,
      'BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID'
    ),
    bankAccountId: positiveInteger(
      bank === 'itau'
        ? env.BRUDAM_ITAU_BANK_ACCOUNT_ID
        : env.BRUDAM_BRADESCO_BANK_ACCOUNT_ID,
      bank === 'itau'
        ? 'BRUDAM_ITAU_BANK_ACCOUNT_ID'
        : 'BRUDAM_BRADESCO_BANK_ACCOUNT_ID'
    )
  };
};

const exactInvoice = async (invoiceId, fetcher = fetchInvoices) => {
  const result = await fetcher({ id: invoiceId, limit: 100, skip: 0 });
  return (result?.invoices || []).find((invoice) => String(invoice.id) === String(invoiceId)) || null;
};

const settlementCovers = (settlement, amount) => (
  Number.isFinite(Number(settlement?.paidAmount)) &&
  Number.isFinite(Number(amount)) &&
  cents(settlement.paidAmount) >= cents(amount)
);

const itauSettlementForRecord = async (record, dependencies = {}) => {
  const detectedAt = String(dependencies.currentDate || '');
  if (!validIsoDate(detectedAt)) {
    throw new Error('Data de detecção do pagamento Itaú inválida.');
  }
  const query = dependencies.queryItauBankSlipDetail || queryItauBankSlipDetail;
  const config = typeof dependencies.itauConfig === 'function'
    ? dependencies.itauConfig()
    : dependencies.itauConfig || itauBoletoConfig();
  const issuedAt = String(record.createdAt || record.issuedAt || '').slice(0, 10);
  if (!validIsoDate(issuedAt) || detectedAt < issuedAt) {
    throw new Error('A detecção do pagamento é anterior à emissão do boleto Itaú.');
  }
  const beneficiaryId = digits(record.beneficiaryId);
  const wallet = digits(record.wallet);
  const ourNumber = digits(record.ourNumber);
  const payerTaxId = digits(record.payer?.tax_id || record.payer?.taxId);
  if (beneficiaryId !== digits(config.beneficiaryId) ||
      wallet !== digits(config.wallet) || !/^\d{1,8}$/.test(ourNumber) ||
      !payerTaxId || !Number.isFinite(Number(record.amount)) || cents(record.amount) <= 0) {
    throw new Error('O boleto Itaú registrado não possui identificadores completos para conciliação.');
  }
  const response = await query({
    beneficiaryId,
    wallet,
    ourNumber
  }, { config });
  if (!Array.isArray(response?.data)) {
    throw new Error('A consulta detalhada Itaú não retornou uma lista de boletos válida.');
  }
  const matches = response.data.filter((item) =>
    digits(item?.beneficiario?.id_beneficiario) === beneficiaryId &&
    digits(item?.dado_boleto?.codigo_carteira) === wallet &&
    Array.isArray(item?.dado_boleto?.dados_individuais_boleto) &&
    item.dado_boleto.dados_individuais_boleto.some((detail) =>
      sameOurNumber(detail?.numero_nosso_numero, ourNumber)));
  if (matches.length > 1) {
    throw new Error('O Itaú retornou mais de um boleto para a mesma referência; baixa automática interrompida.');
  }
  if (!matches.length) {
    if (!response.data.length) return null;
    throw new Error('O detalhe retornado pelo Itaú não corresponde ao boleto registrado.');
  }
  const raw = matches[0];
  if (raw.dado_boleto.dados_individuais_boleto.length !== 1) {
    throw new Error('O Itaú retornou boleto com várias parcelas; não é possível atribuir os pagamentos à fatura.');
  }
  const boleto = (dependencies.normalizeItauBankSlip || normalizeItauBankSlip)(raw);
  if (!boleto?.id || !sameOurNumber(boleto.ourNumber, ourNumber)) {
    throw new Error('O detalhe Itaú não possui identificador individual confiável.');
  }
  if (digits(boleto.payerTaxId) !== payerTaxId) {
    throw new Error('O pagador do boleto Itaú não corresponde ao registro de emissão.');
  }
  if (!Number.isFinite(boleto.amount) || cents(boleto.amount) !== cents(record.amount)) {
    throw new Error('O valor original do boleto Itaú não corresponde ao registro de emissão.');
  }
  if (record.dueAt && String(boleto.dueDate).slice(0, 10) !== String(record.dueAt).slice(0, 10)) {
    throw new Error('O vencimento do boleto Itaú não corresponde ao registro de emissão.');
  }
  if (record.yourNumber && String(boleto.yourNumber).trim() !== String(record.yourNumber).trim()) {
    throw new Error('O Seu Número do boleto Itaú não corresponde ao registro de emissão.');
  }
  const bankStatus = String(boleto.generalStatus || '').trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!['pago', 'paga', 'liquidado', 'liquidada', 'creditado', 'creditada'].includes(bankStatus)) {
    return null;
  }
  const rawPayments = raw.dado_boleto.pagamentos_cobranca;
  if (!Array.isArray(rawPayments) || !rawPayments.length) {
    throw new Error('O Itaú indica pagamento, mas não retornou lançamentos de pagamento.');
  }
  const amounts = rawPayments.map((payment) => itauAmount(payment?.valor_pago_total_cobranca));
  if (amounts.some((amount) => !Number.isFinite(amount) || amount <= 0)) {
    throw new Error('O Itaú retornou um lançamento de pagamento sem valor válido.');
  }
  const paidCents = amounts.reduce((total, amount) => total + cents(amount), 0);
  if (boleto.payments.length !== rawPayments.length ||
      boleto.payments.some((payment) => !validIsoDate(payment.paidAt)) ||
      cents(boleto.paidAmount) !== paidCents) {
    throw new Error('O Itaú retornou lançamento de pagamento sem data ou valor consistente.');
  }
  const paidAt = boleto.payments.map((payment) => payment.paidAt).sort().at(-1);
  if (boleto.payments.some((payment) =>
    payment.paidAt < issuedAt || payment.paidAt > detectedAt)) {
    throw new Error('A data do pagamento Itaú está fora do período entre a emissão e a conferência.');
  }
  if (paidCents < cents(record.amount)) {
    throw new Error('Os pagamentos confirmados pelo Itaú não cobrem integralmente o boleto.');
  }
  return {
    bank: 'itau',
    paidAt,
    paidAmount: paidCents / 100,
    reference: boleto.id,
    beneficiaryId,
    wallet,
    ourNumber,
    payerTaxId,
    paidAtSource: 'itau_v2_payment_inclusion',
    paidAmountSource: 'itau_v2_payments',
    bankStatus: 'pago'
  };
};

const groupedBradescoSettlements = (settlements = []) => {
  const grouped = new Map();
  settlements.forEach((settlement) => {
    const ourNumber = digits(settlement?.ourNumber).padStart(11, '0');
    if (ourNumber.length !== 11 || !settlement?.paidAt) return;
    const current = grouped.get(ourNumber) || {
      bank: 'bradesco',
      paidAt: '',
      paidAmount: 0,
      reference: ourNumber,
      titleAmounts: [],
      payerTaxIds: []
    };
    current.paidAt = [current.paidAt, settlement.paidAt].filter(Boolean).sort().at(-1);
    current.paidAmount = Math.round((current.paidAmount + Number(settlement.paidAmount || 0)) * 100) / 100;
    current.titleAmounts.push(settlement.titleAmount);
    if (digits(settlement.payerTaxId)) current.payerTaxIds.push(digits(settlement.payerTaxId));
    grouped.set(ourNumber, current);
  });
  return grouped;
};

const validateSettlementForRecord = (record, settlement) => {
  if (settlement?.bank !== record.bank || !validIsoDate(settlement?.paidAt)) {
    throw new Error('A confirmação bancária não corresponde ao banco ou não possui data de pagamento válida.');
  }
  if (record.bank === 'itau') {
    if (digits(settlement.beneficiaryId) !== digits(record.beneficiaryId) ||
        digits(settlement.wallet) !== digits(record.wallet) ||
        !sameOurNumber(settlement.ourNumber, record.ourNumber) ||
        settlement.bankStatus !== 'pago' ||
        settlement.paidAtSource !== 'itau_v2_payment_inclusion') {
      throw new Error('A confirmação de pagamento Itaú não corresponde ao boleto registrado.');
    }
    if (settlement.paidAmountSource !== 'itau_v2_payments') {
      throw new Error('A baixa Itaú exige pagamentos confirmados pela consulta detalhada v2.');
    }
    const payerTaxId = digits(record.payer?.tax_id || record.payer?.taxId);
    if (payerTaxId && digits(settlement.payerTaxId) !== payerTaxId) {
      throw new Error('O pagador do boleto Itaú não corresponde ao registro de emissão.');
    }
    return;
  }
  if (record.bank !== 'bradesco') return;
  if (digits(settlement.reference) !== digits(record.ourNumber)) {
    throw new Error('O Nosso Número pago no Bradesco não corresponde ao boleto registrado.');
  }
  if (!Array.isArray(settlement.titleAmounts) || !settlement.titleAmounts.length ||
      settlement.titleAmounts.some((amount) => !Number.isFinite(Number(amount)) ||
        cents(amount) !== cents(record.amount))) {
    throw new Error('O valor original do título pago no Bradesco não corresponde ao boleto registrado.');
  }
  const payerTaxId = digits(record.payer?.tax_id || record.payer?.taxId);
  if (payerTaxId && settlement.payerTaxIds?.some((taxId) => digits(taxId) !== payerTaxId)) {
    throw new Error('O pagador do título pago no Bradesco não corresponde ao boleto registrado.');
  }
};

const prepareLiquidation = (record, settlement, current, dependencies = {}) => {
  validateSettlementForRecord(record, settlement);
  if (!settlementCovers(settlement, record.amount)) {
    throw new Error('O pagamento bancário não cobre integralmente o valor registrado do boleto.');
  }
  if (!current) throw new Error('Fatura do boleto não encontrada na Brudam.');
  if (Number(current.status) === 1) return { status: 'already_settled' };
  if (Number(current.status) !== 0) {
    throw new Error('A fatura não está aberta na Brudam e não pode ser liquidada automaticamente.');
  }
  const balance = Number(current.balance);
  if (!Number.isFinite(balance) || balance <= 0 || !settlementCovers(settlement, balance)) {
    throw new Error('O valor confirmado pelo banco não cobre o saldo atual da fatura na Brudam.');
  }
  if (record.bank === 'itau' && cents(balance) !== cents(record.amount)) {
    throw new Error('O saldo da fatura difere do valor nominal do boleto Itaú; confira antes de liquidar.');
  }
  const internalId = positiveInteger(current.internalId, 'O identificador interno do lançamento');
  const settings = (dependencies.liquidationSettings || brudamLiquidationSettings)(
    record.bank,
    dependencies.env || process.env
  );
  return {
    status: 'eligible',
    internalId,
    invoiceBalance: cents(balance) / 100,
    request: {
      documentos: [{
        id_lancamento: internalId,
        data_pagamento: settlement.paidAt,
        forma_pagamento: settings.paymentMethodId,
        data_credito_debito: settlement.paidAt,
        valor_juros: Math.max(0, cents(settlement.paidAmount) - cents(balance)) / 100,
        // Bradesco: a Brudam espera o total recebido, mesmo com os juros discriminados.
        valor_liquidado: record.bank === 'bradesco'
          ? cents(settlement.paidAmount) / 100
          : cents(balance) / 100,
        conta_bancaria: settings.bankAccountId
      }]
    }
  };
};

const liquidationError = (result) => {
  const data = result?.payload?.data;
  const details = Array.isArray(data) ? data.filter((item) => typeof item === 'string' && item.trim()).join('; ') : '';
  const message = String(result?.payload?.message || '').trim();
  return Object.assign(new Error(
    [message && message.toUpperCase() !== 'OK' ? message : '', details]
      .filter(Boolean).join(': ') || 'A resposta da Brudam não confirmou a liquidação bancária da fatura.'
  ), { statusCode: result?.response?.status >= 400 ? result.response.status : 502 });
};

const liquidationFailure = (error, result) => {
  const httpStatus = Number(result?.response?.status) || null;
  const apiStatus = result?.payload?.status != null && Number.isFinite(Number(result.payload.status))
    ? Number(result.payload.status) : null;
  const dataStatus = result?.payload?.data?.status != null &&
    Number.isFinite(Number(result.payload.data.status))
    ? Number(result.payload.data.status) : null;
  const kind = !result ? 'transport_error'
    : !result.response?.ok || apiStatus === 0 || dataStatus === 0
      ? 'rejected_response' : 'unconfirmed_response';
  return {
    kind,
    httpStatus,
    apiStatus,
    dataStatus,
    code: String(error?.code || error?.cause?.code || '').slice(0, 80),
    message: String(error?.message || error || '').slice(0, 240)
  };
};

const recordLiquidationFailure = async (record, error, result, dependencies = {}) => {
  const failure = liquidationFailure(error, result);
  console.error('[faturamento:conciliacao:baixa-incerta]', {
    invoiceId: record.invoiceId,
    bank: record.bank,
    ...failure
  });
  try {
    const getRecord = dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord;
    const current = await getRecord(record.invoiceId);
    if (current?.reconciliation?.status === 'submission_pending') {
      await (dependencies.saveBankSlipRecord || bankSlipStore.saveBankSlipRecord)(
        record.invoiceId,
        {
          ...current,
          reconciliation: { ...current.reconciliation, failure }
        }
      );
    }
  } catch (saveError) {
    console.error('[faturamento:conciliacao:diagnostico]', {
      invoiceId: record.invoiceId,
      message: String(saveError?.message || saveError).slice(0, 240)
    });
  }
};

const closeBilling = async (invoiceId, settlement, dependencies = {}) => {
  try {
    await Promise.all([
      (dependencies.removePending || billingStore.removePending)(invoiceId),
      ...BILLING_EVENTS.map((event) => (
        dependencies.markBillingEventCompleted || billingStore.markBillingEventCompleted
      )(event, invoiceId, {
        reason: 'bank_payment_reconciliation',
        completedAt: settlement.reconciledAt,
        bank: settlement.bank,
        paidAt: settlement.paidAt
      }))
    ]);
  } catch (error) {
    console.error('[faturamento:conciliacao:encerramento-cobranca]', {
      invoiceId,
      message: String(error.message || error).slice(0, 240)
    });
  }
};

const saveCompletedReconciliation = async (
  record,
  settlement,
  outcome,
  dependencies = {}
) => {
  const reconciledAt = new Date().toISOString();
  const updated = {
    ...record,
    reconciliation: {
      status: 'completed',
      outcome,
      bank: settlement.bank,
      paidAt: settlement.paidAt,
      paidAmount: settlement.paidAmount,
      reconciledAt,
      ...(settlement.paidAtSource ? { paidAtSource: settlement.paidAtSource } : {}),
      ...(settlement.paidAmountSource ? { paidAmountSource: settlement.paidAmountSource } : {}),
      ...(settlement.bankStatus ? { bankStatus: settlement.bankStatus } : {}),
      ...(settlement.reference ? { bankReference: settlement.reference } : {}),
      ...(settlement.liquidationIds ? { liquidationIds: settlement.liquidationIds } : {})
    }
  };
  await (dependencies.saveBankSlipRecord || bankSlipStore.saveBankSlipRecord)(record.invoiceId, updated);
  await closeBilling(record.invoiceId, { ...settlement, reconciledAt }, dependencies);
  return updated;
};

const isManualRetryAuthorized = (record) => (
  String(record?.invoiceId) === ITAU_MANUAL_RETRY_INVOICE_ID &&
  record?.reconciliation?.status === 'submission_pending' &&
  Boolean(record.reconciliation.manualRetryAuthorizedAt) &&
  record.reconciliation.manualRetryAuthorizedAt ===
    record.reconciliationAudit?.manualRetryAuthorizedAt
);

const reconcilePaidRecord = async (record, settlement, dependencies = {}) => {
  const claim = dependencies.claimReconciliationLock || bankSlipStore.claimReconciliationLock;
  const release = dependencies.releaseReconciliationLock || bankSlipStore.releaseReconciliationLock;
  const token = await claim(record.invoiceId);
  if (!token) return { status: 'in_progress' };
  try {
    const savedRecord = await (
      dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord
    )(record.invoiceId);
    if (!savedRecord || savedRecord.state !== 'ready') {
      throw new Error('O boleto registrado mudou durante a conciliação; a baixa foi interrompida.');
    }
    if (savedRecord.reconciliation?.status === 'completed') {
      return { status: 'already_settled' };
    }
    if (savedRecord.reconciliation?.status === 'submission_pending') {
      const current = await exactInvoice(savedRecord.invoiceId, dependencies.fetchInvoices || fetchInvoices);
      if (!current) throw new Error('Fatura do boleto não encontrada na Brudam.');
      if (Number(current.status) === 1) {
        await saveCompletedReconciliation(savedRecord, settlement, 'already_settled', dependencies);
        return { status: 'already_settled' };
      }
      if (!dependencies.allowManualRetry || !isManualRetryAuthorized(savedRecord)) {
        throw new Error('A baixa anterior pode ter sido recebida pela Brudam. Confira manualmente o lançamento antes de uma nova tentativa.');
      }
    }
    validateSettlementForRecord(savedRecord, settlement);
    if (!settlementCovers(settlement, savedRecord.amount)) {
      throw new Error('O pagamento bancário não cobre integralmente o valor registrado do boleto.');
    }
    const current = await exactInvoice(savedRecord.invoiceId, dependencies.fetchInvoices || fetchInvoices);
    const preparation = prepareLiquidation(savedRecord, settlement, current, dependencies);
    if (preparation.status === 'already_settled') {
      await saveCompletedReconciliation(savedRecord, settlement, 'already_settled', dependencies);
      return { status: 'already_settled' };
    }
    const { internalId, request } = preparation;
    await (dependencies.saveBankSlipRecord || bankSlipStore.saveBankSlipRecord)(
      savedRecord.invoiceId,
      {
        ...savedRecord,
        reconciliation: {
          ...settlement,
          status: 'submission_pending',
          attemptedAt: new Date().toISOString(),
          internalId
        }
      }
    );
    let result;
    try {
      result = await (dependencies.liquidate || authenticatedPost)(
        '/financeiro/liquidar/lancamento',
        request
      );
      if (!result?.response?.ok || Number(result?.payload?.status) !== 1 ||
          Number(result?.payload?.data?.status) !== 1) {
        throw liquidationError(result);
      }
    } catch (error) {
      await recordLiquidationFailure(savedRecord, error, result, dependencies);
      throw error;
    }
    const completedSettlement = {
      ...settlement,
      liquidationIds: Array.isArray(result.payload?.data?.ids)
        ? result.payload.data.ids
        : [internalId]
    };
    try {
      await saveCompletedReconciliation(savedRecord, completedSettlement, 'liquidated', dependencies);
    } catch (error) {
      console.error('[faturamento:conciliacao:persistencia]', {
        invoiceId: savedRecord.invoiceId,
        bank: savedRecord.bank,
        message: String(error?.message || error).slice(0, 240)
      });
      throw error;
    }
    return { status: 'liquidated', request };
  } finally {
    try {
      await release(record.invoiceId, token);
    } catch (error) {
      console.error('[faturamento:conciliacao:lock]', {
        invoiceId: record.invoiceId,
        message: String(error.message || error).slice(0, 240)
      });
    }
  }
};

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
};

const itauReconciliationAllowlist = (env = process.env) => {
  const value = String(env.ITAU_RECONCILIATION_INVOICE_IDS || '').trim();
  if (value === '*') return null;
  if (!value) return new Set();
  const invoiceIds = value.split(',').map((item) => item.trim());
  if (invoiceIds.some((item) => !/^\d+$/.test(item))) {
    throw new Error('ITAU_RECONCILIATION_INVOICE_IDS deve conter números de faturas separados por vírgula ou * para todas.');
  }
  return new Set(invoiceIds);
};

const rearmItauReconciliation = async ({ invoiceId, currentDate } = {}, dependencies = {}) => {
  const id = String(invoiceId || '').trim();
  if (id !== ITAU_MANUAL_RETRY_INVOICE_ID || !validIsoDate(currentDate)) {
    throw Object.assign(new Error('Esta recuperação manual não está liberada para a fatura informada.'), {
      statusCode: 403, expose: true
    });
  }
  const env = dependencies.env || process.env;
  const allowlist = itauReconciliationAllowlist(env);
  if (!allowlist || !allowlist.has(id)) {
    throw Object.assign(new Error('Esta fatura não está liberada para conciliação Itaú.'), {
      statusCode: 403, expose: true
    });
  }
  const claim = dependencies.claimReconciliationLock || bankSlipStore.claimReconciliationLock;
  const release = dependencies.releaseReconciliationLock || bankSlipStore.releaseReconciliationLock;
  const token = await claim(id);
  if (!token) {
    throw Object.assign(new Error('Outra conferência desta fatura está em andamento.'), {
      statusCode: 409, expose: true
    });
  }
  try {
    const record = await (dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord)(id);
    if (!record || record.state !== 'ready' || record.bank !== 'itau' ||
        String(record.invoiceId) !== id ||
        record.reconciliation?.status !== 'submission_pending' ||
        record.reconciliationAudit?.manualRetryAuthorizedAt) {
      throw Object.assign(new Error('A tentativa anterior não está apta a uma única liberação manual.'), {
        statusCode: 409, expose: true
      });
    }
    const prior = record.reconciliation;
    const attemptedAt = Date.parse(String(prior.attemptedAt || ''));
    if (!Number.isFinite(attemptedAt) || Date.now() - attemptedAt < 10 * 60 * 1000) {
      throw Object.assign(new Error('A tentativa anterior ainda é recente ou não possui horário confiável.'), {
        statusCode: 409, expose: true
      });
    }
    const settlement = await itauSettlementForRecord(record, { ...dependencies, currentDate });
    if (!settlement) {
      throw Object.assign(new Error('O Itaú não confirma mais o pagamento integral deste boleto.'), {
        statusCode: 409, expose: true
      });
    }
    if ((prior.reference && prior.reference !== settlement.reference) ||
        (prior.paidAt && prior.paidAt !== settlement.paidAt) ||
        (prior.paidAmount != null && cents(prior.paidAmount) !== cents(settlement.paidAmount))) {
      throw Object.assign(new Error('A confirmação bancária mudou desde a primeira tentativa.'), {
        statusCode: 409, expose: true
      });
    }
    const current = await exactInvoice(id, dependencies.fetchInvoices || fetchInvoices);
    const preparation = prepareLiquidation(record, settlement, current, dependencies);
    if (preparation.status !== 'eligible' ||
        preparation.internalId !== Number(prior.internalId) ||
        preparation.request.documentos[0].conta_bancaria !== ITAU_MANUAL_RETRY_BANK_ACCOUNT_ID) {
      throw Object.assign(new Error('A fatura ou o ID interno da conta bancária mudou; liberação interrompida.'), {
        statusCode: 409, expose: true
      });
    }
    const manualRetryAuthorizedAt = new Date().toISOString();
    await (dependencies.saveBankSlipRecord || bankSlipStore.saveBankSlipRecord)(id, {
      ...record,
      reconciliation: { ...prior, manualRetryAuthorizedAt },
      reconciliationAudit: {
        manualRetryAuthorizedAt,
        previousAttempt: {
          attemptedAt: prior.attemptedAt,
          internalId: prior.internalId,
          ...(prior.failure ? { failure: prior.failure } : {})
        }
      }
    });
    console.warn('[faturamento:conciliacao:liberacao-manual]', {
      invoiceId: id,
      internalId: preparation.internalId,
      bankAccountId: ITAU_MANUAL_RETRY_BANK_ACCOUNT_ID,
      manualRetryAuthorizedAt
    });
    return { invoiceId: id, status: 'rearmed', manualOnly: true };
  } finally {
    try {
      await release(id, token);
    } catch (error) {
      console.error('[faturamento:conciliacao:lock-liberacao-manual]', {
        invoiceId: id,
        message: String(error.message || error).slice(0, 240)
      });
    }
  }
};

const previewItauReconciliation = async ({ invoiceId, currentDate } = {}, dependencies = {}) => {
  const id = String(invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(id) || !validIsoDate(currentDate)) {
    throw new Error('Fatura ou data inválida para a prévia de liquidação Itaú.');
  }
  const env = dependencies.env || process.env;
  const allowlist = itauReconciliationAllowlist(env);
  const autoEnabled = allowlist === null || allowlist.has(id);
  const manuallyEnabled = dependencies.manualAll === true;
  const base = { readOnly: true, bank: 'itau', invoiceId: id, autoEnabled };
  const record = await (dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord)(id);
  if (!record || record.bank !== 'itau' || record.state !== 'ready' ||
      String(record.invoiceId || id) !== id) {
    return { ...base, status: 'not_registered', eligible: false,
      message: 'Não há boleto Itaú pronto registrado para esta fatura.' };
  }
  if (record.reconciliation?.status === 'completed') {
    return { ...base, status: 'completed', eligible: false,
      message: 'A conciliação deste boleto já foi concluída.' };
  }
  const manualRetryAuthorized = isManualRetryAuthorized(record);
  if (record.reconciliation?.status === 'submission_pending' && !manualRetryAuthorized) {
    const failure = record.reconciliation.failure;
    let current = null;
    try {
      current = await exactInvoice(id, dependencies.fetchInvoices || fetchInvoices);
    } catch {
      // O POST continua bloqueado mesmo se a consulta read-only falhar.
    }
    const brudamState = current && Number(current.status) === 1
      ? ' A Brudam informa agora que a fatura está liquidada.'
      : current && Number(current.status) === 0
        ? ' A Brudam ainda informa a fatura em aberto.' : '';
    const failureDetail = failure?.message
      ? ` Último erro registrado: ${failure.message}.` : '';
    return { ...base, status: 'manual_review', eligible: false,
      rearmAvailable: id === ITAU_MANUAL_RETRY_INVOICE_ID &&
        Boolean(allowlist?.has(id)) &&
        Boolean(current) && Number(current.status) === 0 &&
        !record.reconciliationAudit?.manualRetryAuthorizedAt,
      message: `Existe uma tentativa de baixa incerta; não faça novo envio.${brudamState}${failureDetail}` };
  }

  let settlement;
  try {
    settlement = await itauSettlementForRecord(record, { ...dependencies, currentDate });
  } catch (error) {
    return { ...base, status: 'blocked', eligible: false, reason: 'bank_validation',
      message: Number.isInteger(error?.upstreamStatus) || Number(error?.statusCode) >= 500
        ? 'A consulta ou validação do boleto Itaú não pôde ser concluída.'
        : String(error.message || error).slice(0, 240) };
  }
  if (!settlement) {
    return { ...base, status: 'not_paid', eligible: false,
      message: 'O Itaú ainda não confirmou o pagamento integral deste boleto.' };
  }

  let current;
  try {
    current = await exactInvoice(id, dependencies.fetchInvoices || fetchInvoices);
  } catch {
    return { ...base, status: 'blocked', eligible: false, reason: 'brudam_query',
      message: 'Não foi possível confirmar a fatura atual na Brudam.' };
  }
  let preparation;
  try {
    preparation = prepareLiquidation(record, settlement, current, dependencies);
  } catch (error) {
    return { ...base, status: 'blocked', eligible: false, reason: 'invoice_validation',
      message: Number(error?.statusCode) >= 500 && !error?.expose
        ? 'Não foi possível concluir a validação da fatura e da configuração bancária.'
        : String(error.message || error).slice(0, 240) };
  }
  if (preparation.status === 'already_settled') {
    return { ...base, status: 'already_settled', eligible: false,
      paidAt: settlement.paidAt, paidAmount: settlement.paidAmount,
      message: 'O Itaú confirma o pagamento e a fatura já está liquidada na Brudam.' };
  }
  const eligible = manualRetryAuthorized ? Boolean(allowlist?.has(id)) : manuallyEnabled || autoEnabled;
  return {
    ...base,
    status: eligible ? 'eligible' : 'disabled',
    eligible,
    paidAt: settlement.paidAt,
    paidAmount: settlement.paidAmount,
    invoiceBalance: preparation.invoiceBalance,
    message: eligible
      ? manualRetryAuthorized
        ? 'Pagamento e fatura conferidos. Liberada uma única nova tentativa manual; o agendador permanece bloqueado.'
        : manuallyEnabled && !autoEnabled
          ? 'Pagamento e fatura conferidos. A baixa manual está disponível; o agendador continua restrito.'
          : 'Pagamento e fatura conferidos. A próxima execução pode realizar a baixa.'
      : 'Pagamento e fatura conferidos, mas a baixa automática Itaú não está liberada para esta fatura.'
  };
};

const reconcileItauInvoice = async ({ invoiceId, currentDate } = {}, dependencies = {}) => {
  const id = String(invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(id) || !validIsoDate(currentDate)) {
    throw new Error('Fatura ou data inválida para a baixa Itaú.');
  }
  const allowlist = itauReconciliationAllowlist(dependencies.env || process.env);
  if (!dependencies.manualAll && (!allowlist || !allowlist.has(id))) {
    throw Object.assign(new Error('Esta fatura não está liberada para baixa Itaú direcionada.'), {
      statusCode: 403,
      expose: true
    });
  }
  const getRecord = dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord;
  const record = await getRecord(id);
  if (!record || record.bank !== 'itau' || record.state !== 'ready' ||
      String(record.invoiceId || id) !== id) {
    throw Object.assign(new Error('Não há boleto Itaú pronto registrado para esta fatura.'), {
      statusCode: 409,
      expose: true
    });
  }
  if (record.reconciliation?.status === 'completed') {
    return { invoiceId: id, status: 'already_settled' };
  }
  const manualRetryAuthorized = isManualRetryAuthorized(record);
  const settlement = record.reconciliation?.status === 'submission_pending' && !manualRetryAuthorized
    ? record.reconciliation
    : await itauSettlementForRecord(record, { ...dependencies, currentDate });
  if (!settlement) return { invoiceId: id, status: 'not_paid' };
  try {
    const result = await reconcilePaidRecord(record, settlement, {
      ...dependencies,
      allowManualRetry: manualRetryAuthorized
    });
    return { invoiceId: id, status: result.status };
  } catch (error) {
    const latest = await Promise.resolve().then(() => getRecord(id)).catch(() => null);
    if (latest?.reconciliation?.status === 'submission_pending') {
      return { invoiceId: id, status: 'manual_review' };
    }
    throw error;
  }
};

const bradescoSettlementForRecord = async (record, currentDate, dependencies = {}) => {
  const listRecords = dependencies.listBankSlipRecords ||
    (() => bankSlipStore.listBankSlipRecords(undefined, { count: 500, maxIterations: 100 }));
  const records = await listRecords();
  const matchingOurNumber = records.filter((item) => item?.state === 'ready' &&
    item.bank === 'bradesco' && sameOurNumber(item.ourNumber, record.ourNumber));
  if (matchingOurNumber.length !== 1 ||
      String(matchingOurNumber[0].invoiceId) !== String(record.invoiceId)) {
    throw new Error('Nosso Número Bradesco associado a mais de uma fatura; baixa interrompida.');
  }
  const config = typeof dependencies.bradescoConfig === 'function'
    ? dependencies.bradescoConfig()
    : dependencies.bradescoConfig || bradescoConfig();
  const settlements = await (
    dependencies.listBradescoSettledBankSlips || listBradescoSettledBankSlips
  )({
    paymentDateFrom: addDays(currentDate, -60),
    paymentDateTo: addDays(currentDate, -1)
  }, { config });
  return groupedBradescoSettlements(settlements)
    .get(digits(record.ourNumber).padStart(11, '0')) || null;
};

const previewBradescoReconciliation = async ({ invoiceId, currentDate } = {}, dependencies = {}) => {
  const id = String(invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(id) || !validIsoDate(currentDate)) {
    throw new Error('Fatura ou data inválida para a prévia de liquidação Bradesco.');
  }
  const base = { readOnly: true, bank: 'bradesco', invoiceId: id };
  const record = await (dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord)(id);
  if (!record || record.bank !== 'bradesco' || record.state !== 'ready' ||
      String(record.invoiceId || id) !== id) {
    return { ...base, status: 'not_registered', eligible: false,
      message: 'Não há boleto Bradesco pronto registrado para esta fatura.' };
  }
  if (record.reconciliation?.status === 'completed') {
    return { ...base, status: 'completed', eligible: false,
      message: 'A conciliação deste boleto já foi concluída.' };
  }
  if (record.reconciliation?.status === 'submission_pending') {
    return { ...base, status: 'manual_review', eligible: false,
      message: 'Existe uma tentativa de baixa incerta. Confira o lançamento na Brudam; o sistema não fará novo POST.' };
  }
  let settlement;
  try {
    settlement = await bradescoSettlementForRecord(record, currentDate, dependencies);
  } catch (error) {
    return { ...base, status: 'blocked', eligible: false, reason: 'bank_validation',
      message: String(error.message || error).slice(0, 240) };
  }
  if (!settlement) {
    return { ...base, status: 'not_paid', eligible: false,
      message: 'O Bradesco ainda não confirmou o pagamento integral deste boleto.' };
  }
  let current;
  try {
    current = await exactInvoice(id, dependencies.fetchInvoices || fetchInvoices);
  } catch {
    return { ...base, status: 'blocked', eligible: false, reason: 'brudam_query',
      message: 'Não foi possível confirmar a fatura atual na Brudam.' };
  }
  let preparation;
  try {
    preparation = prepareLiquidation(record, settlement, current, dependencies);
  } catch (error) {
    return { ...base, status: 'blocked', eligible: false, reason: 'invoice_validation',
      message: Number(error?.statusCode) >= 500 && !error?.expose
        ? 'Não foi possível concluir a validação da fatura e da configuração bancária.'
        : String(error.message || error).slice(0, 240) };
  }
  return {
    ...base,
    status: preparation.status === 'already_settled' ? 'already_settled' : 'eligible',
    eligible: preparation.status === 'eligible',
    paidAt: settlement.paidAt,
    paidAmount: settlement.paidAmount,
    ...(preparation.request ? { invoiceBalance: preparation.invoiceBalance } : {}),
    message: preparation.status === 'already_settled'
      ? 'O Bradesco confirma o pagamento e a fatura já está liquidada na Brudam.'
      : 'Pagamento e fatura conferidos. A baixa manual está disponível.'
  };
};

const reconcileBradescoInvoice = async ({ invoiceId, currentDate } = {}, dependencies = {}) => {
  const id = String(invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(id) || !validIsoDate(currentDate)) {
    throw new Error('Fatura ou data inválida para a baixa Bradesco.');
  }
  const getRecord = dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord;
  const record = await getRecord(id);
  if (!record || record.bank !== 'bradesco' || record.state !== 'ready' ||
      String(record.invoiceId || id) !== id) {
    throw Object.assign(new Error('Não há boleto Bradesco pronto registrado para esta fatura.'), {
      statusCode: 409, expose: true
    });
  }
  if (record.reconciliation?.status === 'completed') {
    return { invoiceId: id, status: 'already_settled' };
  }
  const settlement = record.reconciliation?.status === 'submission_pending'
    ? record.reconciliation
    : await bradescoSettlementForRecord(record, currentDate, dependencies);
  if (!settlement) return { invoiceId: id, status: 'not_paid' };
  try {
    const result = await reconcilePaidRecord(record, settlement, dependencies);
    return { invoiceId: id, status: result.status };
  } catch (error) {
    const latest = await Promise.resolve().then(() => getRecord(id)).catch(() => null);
    if (latest?.reconciliation?.status === 'submission_pending') {
      return { invoiceId: id, status: 'manual_review' };
    }
    throw error;
  }
};

const previewBankReconciliation = async (input = {}, dependencies = {}) => {
  const id = String(input.invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Número da fatura inválido.');
  const record = await (dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord)(id);
  if (record?.bank === 'itau') {
    return previewItauReconciliation(input, { ...dependencies, manualAll: true });
  }
  if (record?.bank === 'bradesco') return previewBradescoReconciliation(input, dependencies);
  return { readOnly: true, invoiceId: id, status: 'not_registered', eligible: false,
    message: 'Não há boleto Itaú ou Bradesco pronto registrado para esta fatura.' };
};

const reconcileBankInvoice = async (input = {}, dependencies = {}) => {
  const id = String(input.invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Número da fatura inválido.');
  const record = await (dependencies.getBankSlipRecord || bankSlipStore.getBankSlipRecord)(id);
  if (record?.bank === 'itau') {
    return reconcileItauInvoice(input, { ...dependencies, manualAll: true });
  }
  if (record?.bank === 'bradesco') return reconcileBradescoInvoice(input, dependencies);
  throw Object.assign(new Error('Não há boleto Itaú ou Bradesco pronto registrado para esta fatura.'), {
    statusCode: 409, expose: true
  });
};

const invoiceIdCompare = (left, right) => String(left).localeCompare(
  String(right), 'pt-BR', { numeric: true }
);

const reconcileBankPayments = async ({
  currentDate,
  maxRecords = 8,
  manualFullScan = false,
  afterInvoiceId = ''
} = {}, dependencies = {}) => {
  if (!validIsoDate(currentDate)) throw new Error('Data da conciliação bancária inválida.');
  if (manualFullScan && afterInvoiceId && !/^\d{1,20}$/.test(String(afterInvoiceId))) {
    throw Object.assign(new Error('Cursor de liquidação inválido.'), { statusCode: 422, expose: true });
  }
  const itauAllowlist = itauReconciliationAllowlist(dependencies.env || process.env);
  const listRecords = dependencies.listBankSlipRecords || (manualFullScan
    ? () => bankSlipStore.listBankSlipRecords(undefined, { count: 500, maxIterations: 100 })
    : bankSlipStore.listBankSlipRecords);
  const [records, ignoredIds] = await Promise.all([
    listRecords(),
    (dependencies.listIgnoredBankReconciliationIds || billingStore.listIgnoredBankReconciliationIds)()
  ]);
  const ignored = new Set(ignoredIds.map(String));
  const active = records.filter((record) => (
    record?.state === 'ready' &&
    BANKS.has(record.bank) &&
    !ignored.has(String(record.invoiceId)) &&
    record.reconciliation?.status !== 'completed' &&
    (record.bank !== 'itau' || record.reconciliation?.status === 'submission_pending' ||
      manualFullScan || itauAllowlist === null || itauAllowlist.has(String(record.invoiceId)))
  )).sort((left, right) => invoiceIdCompare(left.invoiceId, right.invoiceId));
  if (!active.length) {
    if (!manualFullScan) {
      await (dependencies.saveReconciliationCursor || billingStore.saveReconciliationCursor)(0);
    }
    return { checked: 0, settled: 0, alreadySettled: 0, pending: 0, errors: [], results: [],
      ...(manualFullScan ? { hasMore: false, nextCursor: '', totalCandidates: 0 } : {}) };
  }
  const batchSize = Math.max(1, Math.min(Number(maxRecords) || 8, 25));
  let start = 0;
  let candidates;
  if (manualFullScan) {
    candidates = afterInvoiceId
      ? active.filter((record) => invoiceIdCompare(record.invoiceId, afterInvoiceId) > 0)
      : active;
  } else {
    const storedCursor = await (
      dependencies.getReconciliationCursor || billingStore.getReconciliationCursor
    )();
    start = Math.max(0, Number(storedCursor) || 0) % active.length;
    candidates = [...active.slice(start), ...active.slice(0, start)];
  }
  const selected = candidates.slice(0, batchSize);
  const bradescoNumberCounts = new Map();
  records.filter((record) => record?.state === 'ready' && record.bank === 'bradesco')
    .forEach((record) => {
      const ourNumber = digits(record.ourNumber).padStart(11, '0');
      bradescoNumberCounts.set(ourNumber, (bradescoNumberCounts.get(ourNumber) || 0) + 1);
    });

  let bradescoSettlements = new Map();
  let bradescoError = null;
  if (selected.some((record) => record.bank === 'bradesco' &&
      record.reconciliation?.status !== 'submission_pending')) {
    try {
      const config = typeof dependencies.bradescoConfig === 'function'
        ? dependencies.bradescoConfig()
        : dependencies.bradescoConfig || bradescoConfig();
      const list = await (
        dependencies.listBradescoSettledBankSlips || listBradescoSettledBankSlips
      )({
        paymentDateFrom: addDays(currentDate, -60),
        paymentDateTo: addDays(currentDate, -1)
      }, { config });
      bradescoSettlements = groupedBradescoSettlements(list);
    } catch (error) {
      bradescoError = error;
    }
  }

  const results = await mapWithConcurrency(selected, 3, async (record) => {
    try {
      if (record.bank === 'bradesco' && bradescoError &&
          record.reconciliation?.status !== 'submission_pending') throw bradescoError;
      if (record.bank === 'bradesco' &&
          bradescoNumberCounts.get(digits(record.ourNumber).padStart(11, '0')) !== 1) {
        throw new Error('Nosso Número Bradesco associado a mais de uma fatura; baixa automática interrompida.');
      }
      const settlement = record.reconciliation?.status === 'submission_pending'
        ? record.reconciliation
        : record.bank === 'itau'
        ? await itauSettlementForRecord(record, { ...dependencies, currentDate })
        : bradescoSettlements.get(digits(record.ourNumber).padStart(11, '0')) || null;
      if (!settlement) return { invoiceId: record.invoiceId, status: 'pending' };
      const outcome = await reconcilePaidRecord(record, settlement, dependencies);
      return { invoiceId: record.invoiceId, ...outcome };
    } catch (error) {
      return {
        invoiceId: String(record.invoiceId),
        bank: record.bank,
        status: 'error',
        message: String(error.message || error).slice(0, 300),
        ...(Number.isInteger(error?.upstreamStatus)
          ? { httpStatus: error.upstreamStatus } : {})
      };
    }
  });
  if (!manualFullScan) {
    await (dependencies.saveReconciliationCursor || billingStore.saveReconciliationCursor)(
      (start + selected.length) % active.length
    );
  }
  return {
    checked: selected.length,
    settled: results.filter((item) => item.status === 'liquidated').length,
    alreadySettled: results.filter((item) => item.status === 'already_settled').length,
    pending: results.filter((item) => ['pending', 'in_progress'].includes(item.status)).length,
    errors: results.filter((item) => item.status === 'error'),
    results,
    ...(manualFullScan ? {
      hasMore: candidates.length > selected.length,
      nextCursor: String(selected.at(-1)?.invoiceId || ''),
      totalCandidates: active.length
    } : {})
  };
};

module.exports = {
  brudamLiquidationSettings,
  settlementCovers,
  itauSettlementForRecord,
  groupedBradescoSettlements,
  itauReconciliationAllowlist,
  rearmItauReconciliation,
  previewItauReconciliation,
  reconcileItauInvoice,
  previewBankReconciliation,
  reconcileBankInvoice,
  reconcilePaidRecord,
  reconcileBankPayments
};
