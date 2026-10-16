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
    request: {
      documentos: [{
        id_lancamento: internalId,
        data_pagamento: settlement.paidAt,
        forma_pagamento: settings.paymentMethodId,
        data_credito_debito: settlement.paidAt,
        valor_juros: Math.max(0, Math.round((settlement.paidAmount - balance) * 100) / 100),
        valor_liquidado: Math.round(balance * 100) / 100,
        conta_bancaria: settings.bankAccountId
      }]
    }
  };
};

const liquidationError = (result) => {
  const data = result?.payload?.data;
  const details = Array.isArray(data) ? data.filter(Boolean).join('; ') : '';
  const message = String(result?.payload?.message || '').trim();
  return Object.assign(new Error(
    [message && message.toUpperCase() !== 'OK' ? message : '', details]
      .filter(Boolean).join(': ') || 'A Brudam recusou a liquidação bancária da fatura.'
  ), { statusCode: result?.response?.status >= 400 ? result.response.status : 502 });
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
      throw new Error('A baixa anterior pode ter sido recebida pela Brudam. Confira manualmente o lançamento antes de uma nova tentativa.');
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
    const result = await (dependencies.liquidate || authenticatedPost)(
      '/financeiro/liquidar/lancamento',
      request
    );
    if (!result?.response?.ok || Number(result?.payload?.status) !== 1 ||
        Number(result?.payload?.data?.status) !== 1) {
      throw liquidationError(result);
    }
    const completedSettlement = {
      ...settlement,
      liquidationIds: Array.isArray(result.payload?.data?.ids)
        ? result.payload.data.ids
        : [internalId]
    };
    await saveCompletedReconciliation(savedRecord, completedSettlement, 'liquidated', dependencies);
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

const previewItauReconciliation = async ({ invoiceId, currentDate } = {}, dependencies = {}) => {
  const id = String(invoiceId || '').trim();
  if (!/^\d{1,20}$/.test(id) || !validIsoDate(currentDate)) {
    throw new Error('Fatura ou data inválida para a prévia de liquidação Itaú.');
  }
  const env = dependencies.env || process.env;
  const allowlist = itauReconciliationAllowlist(env);
  const autoEnabled = allowlist === null || allowlist.has(id);
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
  if (record.reconciliation?.status === 'submission_pending') {
    return { ...base, status: 'manual_review', eligible: false,
      message: 'Existe uma tentativa de baixa incerta; confira a Brudam antes de qualquer novo envio.' };
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
  return {
    ...base,
    status: autoEnabled ? 'eligible' : 'disabled',
    eligible: autoEnabled,
    paidAt: settlement.paidAt,
    paidAmount: settlement.paidAmount,
    invoiceBalance: preparation.request.documentos[0].valor_liquidado,
    message: autoEnabled
      ? 'Pagamento e fatura conferidos. A próxima execução pode realizar a baixa.'
      : 'Pagamento e fatura conferidos, mas a baixa automática Itaú não está liberada para esta fatura.'
  };
};

const reconcileBankPayments = async ({ currentDate, maxRecords = 8 } = {}, dependencies = {}) => {
  if (!validIsoDate(currentDate)) throw new Error('Data da conciliação bancária inválida.');
  const itauAllowlist = itauReconciliationAllowlist(dependencies.env || process.env);
  const records = await (dependencies.listBankSlipRecords || bankSlipStore.listBankSlipRecords)();
  const active = records.filter((record) => (
    record?.state === 'ready' &&
    BANKS.has(record.bank) &&
    record.reconciliation?.status !== 'completed' &&
    (record.bank !== 'itau' || record.reconciliation?.status === 'submission_pending' ||
      itauAllowlist === null || itauAllowlist.has(String(record.invoiceId)))
  )).sort((left, right) => String(left.invoiceId).localeCompare(
    String(right.invoiceId), 'pt-BR', { numeric: true }
  ));
  if (!active.length) {
    await (dependencies.saveReconciliationCursor || billingStore.saveReconciliationCursor)(0);
    return { checked: 0, settled: 0, alreadySettled: 0, pending: 0, errors: [] };
  }
  const storedCursor = await (
    dependencies.getReconciliationCursor || billingStore.getReconciliationCursor
  )();
  const start = Math.max(0, Number(storedCursor) || 0) % active.length;
  const rotated = [...active.slice(start), ...active.slice(0, start)];
  const selected = rotated.slice(0, Math.max(1, Math.min(Number(maxRecords) || 8, 25)));
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
        message: String(error.message || error).slice(0, 300)
      };
    }
  });
  await (dependencies.saveReconciliationCursor || billingStore.saveReconciliationCursor)(
    (start + selected.length) % active.length
  );
  return {
    checked: selected.length,
    settled: results.filter((item) => item.status === 'liquidated').length,
    alreadySettled: results.filter((item) => item.status === 'already_settled').length,
    pending: results.filter((item) => ['pending', 'in_progress'].includes(item.status)).length,
    errors: results.filter((item) => item.status === 'error'),
    results
  };
};

module.exports = {
  brudamLiquidationSettings,
  settlementCovers,
  itauSettlementForRecord,
  groupedBradescoSettlements,
  itauReconciliationAllowlist,
  previewItauReconciliation,
  reconcilePaidRecord,
  reconcileBankPayments
};
