const bankSlipStore = require('./boleto-store');

const PAYMENT_LOG_KEY = 'faturamento:liquidacoes:planilhas:v1';
const MAX_READ_ROWS = 200;

const validInvoiceId = (value) => /^\d{1,20}$/.test(String(value || ''));
const validIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const validTimestamp = (value) => !Number.isNaN(Date.parse(String(value || '')));
const money = (value) => Math.round(Number(value) * 100) / 100;

const recordPaymentLiquidation = async (entry, command = bankSlipStore.redisCommand) => {
  if (!validInvoiceId(entry?.invoiceId) || !validIsoDate(entry?.paidAt) ||
      !validTimestamp(entry?.completedAt) || !Number.isFinite(Number(entry?.amount)) ||
      Number(entry.amount) <= 0) {
    throw new Error('Dados incompletos para o histórico da liquidação.');
  }
  const record = {
    invoiceId: String(entry.invoiceId),
    source: 'white_martins_spreadsheet',
    outcome: 'liquidated',
    paidAt: entry.paidAt,
    amount: money(entry.amount),
    completedAt: entry.completedAt
  };
  await command('LPUSH', PAYMENT_LOG_KEY, JSON.stringify(record));
  return record;
};

const listPaymentLiquidations = async (command = bankSlipStore.redisCommand) => {
  const rows = await command('LRANGE', PAYMENT_LOG_KEY, '0', String(MAX_READ_ROWS - 1)) || [];
  if (!Array.isArray(rows)) throw new Error('Histórico de planilhas indisponível.');
  return rows.flatMap((value) => {
    try {
      const row = JSON.parse(value);
      return validInvoiceId(row?.invoiceId) && row?.outcome === 'liquidated' &&
        validIsoDate(row?.paidAt) && validTimestamp(row?.completedAt) &&
        Number.isFinite(Number(row?.amount)) && Number(row.amount) > 0
        ? [{
          invoiceId: String(row.invoiceId),
          source: 'white_martins_spreadsheet',
          outcome: 'liquidated',
          paidAt: row.paidAt,
          amount: money(row.amount),
          completedAt: row.completedAt
        }]
        : [];
    } catch {
      return [];
    }
  });
};

const bankLiquidationRows = (records) => records.flatMap((record) => {
  const reconciliation = record?.reconciliation;
  if (record?.state !== 'ready' || reconciliation?.status !== 'completed' ||
      !['itau', 'bradesco'].includes(record.bank) || !validInvoiceId(record.invoiceId) ||
      !validIsoDate(reconciliation.paidAt) || !validTimestamp(reconciliation.reconciledAt) ||
      !Number.isFinite(Number(reconciliation.paidAmount)) || Number(reconciliation.paidAmount) <= 0 ||
      !['liquidated', 'already_settled'].includes(reconciliation.outcome)) return [];
  return [{
    invoiceId: String(record.invoiceId),
    source: record.bank,
    outcome: reconciliation.outcome,
    paidAt: reconciliation.paidAt,
    amount: money(reconciliation.paidAmount),
    completedAt: reconciliation.reconciledAt
  }];
});

const listLiquidationLog = async (dependencies = {}) => {
  const [bankRecords, paymentRecords] = await Promise.all([
    (dependencies.listBankSlipRecords || bankSlipStore.listBankSlipRecords)(),
    (dependencies.listPaymentLiquidations || listPaymentLiquidations)()
  ]);
  return [...bankLiquidationRows(bankRecords), ...paymentRecords]
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, 100);
};

module.exports = {
  PAYMENT_LOG_KEY,
  recordPaymentLiquidation,
  listPaymentLiquidations,
  bankLiquidationRows,
  listLiquidationLog
};
