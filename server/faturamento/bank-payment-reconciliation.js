const { queryItauBankSlips, itauBoletoConfig } = require('./itau');
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
  const query = dependencies.queryItauBankSlips || queryItauBankSlips;
  const config = typeof dependencies.itauConfig === 'function'
    ? dependencies.itauConfig()
    : dependencies.itauConfig || itauBoletoConfig();
  const inclusionDate = String(record.createdAt || record.issuedAt || '').slice(0, 10);
  if (!validIsoDate(inclusionDate)) {
    throw new Error('O boleto Itaú não possui data de inclusão válida para consulta específica.');
  }
  const list = await query({
    beneficiaryId: record.beneficiaryId || config.beneficiaryId,
    wallet: record.wallet || config.wallet,
    ourNumber: record.ourNumber,
    inclusionDate,
    view: 'specific'
  }, { config });
  const ourNumber = digits(record.ourNumber);
  const boleto = list.find((item) => digits(item.ourNumber) === ourNumber);
  if (!boleto?.paidAt || !settlementCovers(boleto, record.amount)) return null;
  return {
    bank: 'itau',
    paidAt: boleto.paidAt,
    paidAmount: boleto.paidAmount,
    reference: boleto.id || record.bankSlipId
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
      reference: ourNumber
    };
    current.paidAt = [current.paidAt, settlement.paidAt].filter(Boolean).sort().at(-1);
    current.paidAmount = Math.round((current.paidAmount + Number(settlement.paidAmount || 0)) * 100) / 100;
    grouped.set(ourNumber, current);
  });
  return grouped;
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
      ...(settlement.liquidationIds ? { liquidationIds: settlement.liquidationIds } : {})
    }
  };
  await (dependencies.saveBankSlipRecord || bankSlipStore.saveBankSlipRecord)(record.invoiceId, updated);
  await closeBilling(record.invoiceId, { ...settlement, reconciledAt }, dependencies);
  return updated;
};

const reconcilePaidRecord = async (record, settlement, dependencies = {}) => {
  if (!settlementCovers(settlement, record.amount)) {
    throw new Error('O pagamento bancário não cobre integralmente o valor registrado do boleto.');
  }
  const current = await exactInvoice(record.invoiceId, dependencies.fetchInvoices || fetchInvoices);
  if (!current) throw new Error('Fatura do boleto não encontrada na Brudam.');
  if (Number(current.status) === 1 || cents(current.balance) <= 0) {
    await saveCompletedReconciliation(record, settlement, 'already_settled', dependencies);
    return { status: 'already_settled' };
  }
  if (Number(current.status) !== 0) {
    throw new Error('A fatura não está aberta na Brudam e não pode ser liquidada automaticamente.');
  }
  const balance = Number(current.balance);
  if (!Number.isFinite(balance) || balance <= 0 || !settlementCovers(settlement, balance)) {
    throw new Error('O valor confirmado pelo banco não cobre o saldo atual da fatura na Brudam.');
  }
  const internalId = positiveInteger(current.internalId, 'O identificador interno do lançamento');
  const settings = (dependencies.liquidationSettings || brudamLiquidationSettings)(
    record.bank,
    dependencies.env || process.env
  );
  const request = {
    documentos: [{
      id_lancamento: internalId,
      data_pagamento: settlement.paidAt,
      forma_pagamento: settings.paymentMethodId,
      data_credito_debito: settlement.paidAt,
      valor_juros: Math.max(0, Math.round((settlement.paidAmount - balance) * 100) / 100),
      valor_liquidado: Math.round(balance * 100) / 100,
      conta_bancaria: settings.bankAccountId
    }]
  };
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
  await saveCompletedReconciliation(record, completedSettlement, 'liquidated', dependencies);
  return { status: 'liquidated', request };
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

const reconcileBankPayments = async ({ currentDate, maxRecords = 8 } = {}, dependencies = {}) => {
  if (!validIsoDate(currentDate)) throw new Error('Data da conciliação bancária inválida.');
  const records = await (dependencies.listBankSlipRecords || bankSlipStore.listBankSlipRecords)();
  const active = records.filter((record) => (
    record?.state === 'ready' &&
    BANKS.has(record.bank) &&
    record.reconciliation?.status !== 'completed'
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

  let bradescoSettlements = new Map();
  let bradescoError = null;
  if (selected.some((record) => record.bank === 'bradesco')) {
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
      if (record.bank === 'bradesco' && bradescoError) throw bradescoError;
      const settlement = record.bank === 'itau'
        ? await itauSettlementForRecord(record, dependencies)
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
    pending: results.filter((item) => item.status === 'pending').length,
    errors: results.filter((item) => item.status === 'error'),
    results
  };
};

module.exports = {
  brudamLiquidationSettings,
  settlementCovers,
  itauSettlementForRecord,
  groupedBradescoSettlements,
  reconcilePaidRecord,
  reconcileBankPayments
};
