const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recordPaymentLiquidation,
  listPaymentLiquidations,
  listLiquidationLog
} = require('../server/faturamento/liquidation-log');

test('registra somente dados essenciais da baixa por planilha e preserva o histórico', async () => {
  const rows = [];
  const command = async (operation, _key, ...args) => {
    if (operation === 'LPUSH') rows.unshift(args[0]);
    if (operation === 'LRANGE') return rows;
    return 'OK';
  };
  await recordPaymentLiquidation({
    invoiceId: '11840', paidAt: '2026-09-29', amount: 1385.65,
    completedAt: '2026-10-17T12:00:00Z', payerTaxId: 'não deve ir ao log'
  }, command);
  assert.deepEqual(await listPaymentLiquidations(command), [{
    invoiceId: '11840', source: 'white_martins_spreadsheet', outcome: 'liquidated',
    paidAt: '2026-09-29', amount: 1385.65, completedAt: '2026-10-17T12:00:00Z'
  }]);
  assert.equal(rows[0].includes('payerTaxId'), false);
});

test('histórico mostra somente baixas feitas pelo sistema, sem tentativas nem baixas prévias na Brudam', async () => {
  const result = await listLiquidationLog({
    listBankSlipRecords: async () => [
      {
        state: 'ready', invoiceId: '11838', bank: 'itau',
        reconciliation: {
          status: 'completed', outcome: 'liquidated', paidAt: '2026-10-13',
          paidAmount: 128.81, reconciledAt: '2026-10-17T14:00:00Z'
        }
      },
      {
        state: 'ready', invoiceId: '11901', bank: 'bradesco',
        reconciliation: { status: 'submission_pending', paidAt: '2026-10-14' }
      },
      {
        state: 'ready', invoiceId: '11817', bank: 'itau',
        reconciliation: {
          status: 'completed', outcome: 'already_settled', paidAt: '2026-10-13',
          paidAmount: 1727.33, reconciledAt: '2026-10-16T14:00:00Z'
        }
      }
    ],
    listPaymentLiquidations: async () => [{
      invoiceId: '11840', source: 'white_martins_spreadsheet', outcome: 'liquidated',
      paidAt: '2026-09-29', amount: 1385.65, completedAt: '2026-10-17T15:00:00Z'
    }, {
      invoiceId: '11841', source: 'white_martins_spreadsheet', outcome: 'already_settled',
      paidAt: '2026-09-29', amount: 10, completedAt: '2026-10-18T15:00:00Z'
    }]
  });
  assert.deepEqual(result.map((row) => row.invoiceId), ['11840', '11838']);
  assert.equal(result[1].amount, 128.81);
  assert.ok(result.every((row) => row.outcome === 'liquidated'));
});
