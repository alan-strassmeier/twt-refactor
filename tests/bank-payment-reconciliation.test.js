const test = require('node:test');
const assert = require('node:assert/strict');

const {
  brudamLiquidationSettings,
  reconcilePaidRecord,
  reconcileBankPayments
} = require('../server/faturamento/bank-payment-reconciliation');

test('exige IDs internos distintos das contas bancárias físicas para liquidar na Brudam', () => {
  assert.deepEqual(brudamLiquidationSettings('itau', {
    BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID: '7',
    BRUDAM_ITAU_BANK_ACCOUNT_ID: '16666'
  }), { paymentMethodId: 7, bankAccountId: 16666 });
  assert.throws(
    () => brudamLiquidationSettings('bradesco', {
      BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID: '7'
    }),
    /BRUDAM_BRADESCO_BANK_ACCOUNT_ID/
  );
});

test('pagamento integral confirmado pelo banco liquida somente o saldo e separa os juros', async () => {
  const calls = { completed: [], removed: [], saved: [] };
  const result = await reconcilePaidRecord({
    state: 'ready',
    invoiceId: '11777',
    bank: 'bradesco',
    bankSlipId: '00000021311',
    amount: 100
  }, {
    bank: 'bradesco',
    paidAt: '2026-09-29',
    paidAmount: 103,
    reference: '00000021311'
  }, {
    fetchInvoices: async () => ({ invoices: [{
      id: '11777',
      internalId: 84583298,
      status: 0,
      balance: 100
    }] }),
    liquidationSettings: () => ({ paymentMethodId: 7, bankAccountId: 321 }),
    liquidate: async (path, body) => {
      calls.path = path;
      calls.body = body;
      return {
        response: { ok: true, status: 200 },
        payload: { status: 1, data: { status: 1, ids: [84583298] } }
      };
    },
    saveBankSlipRecord: async (_invoiceId, record) => { calls.saved.push(record); },
    removePending: async (invoiceId) => { calls.removed.push(invoiceId); },
    markBillingEventCompleted: async (event) => { calls.completed.push(event); }
  });
  assert.equal(result.status, 'liquidated');
  assert.equal(calls.path, '/financeiro/liquidar/lancamento');
  assert.deepEqual(calls.body, {
    documentos: [{
      id_lancamento: 84583298,
      data_pagamento: '2026-09-29',
      forma_pagamento: 7,
      data_credito_debito: '2026-09-29',
      valor_juros: 3,
      valor_liquidado: 100,
      conta_bancaria: 321
    }]
  });
  assert.equal(calls.saved[0].reconciliation.status, 'completed');
  assert.equal(calls.saved[0].reconciliation.outcome, 'liquidated');
  assert.deepEqual(calls.removed, ['11777']);
  assert.deepEqual(calls.completed.sort(), ['initial', 'overdue', 'reminder']);
});

test('rotina consulta o Itaú em visão específica e não baixa pagamento parcial', async () => {
  let liquidations = 0;
  let savedCursor = null;
  const result = await reconcileBankPayments({
    currentDate: '2026-09-30',
    maxRecords: 8
  }, {
    listBankSlipRecords: async () => [{
      state: 'ready',
      invoiceId: '11518',
      bank: 'itau',
      bankSlipId: '15000005206110900011518',
      beneficiaryId: '150000052061',
      wallet: '109',
      ourNumber: '00011518',
      amount: 200,
      createdAt: '2026-09-20T12:00:00.000Z'
    }],
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async (cursor) => { savedCursor = cursor; },
    itauConfig: {
      beneficiaryId: '150000052061',
      wallet: '109'
    },
    queryItauBankSlips: async (criteria) => {
      assert.deepEqual(criteria, {
        beneficiaryId: '150000052061',
        wallet: '109',
        ourNumber: '00011518',
        inclusionDate: '2026-09-20',
        view: 'specific'
      });
      return [{
        id: 'boleto-itau',
        ourNumber: '00011518',
        paidAt: '2026-09-29',
        paidAmount: 150
      }];
    },
    liquidate: async () => { liquidations += 1; }
  });
  assert.equal(result.checked, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.settled, 0);
  assert.equal(liquidations, 0);
  assert.equal(savedCursor, 0);
});

test('fatura já liquidada é encerrada sem repetir POST na Brudam', async () => {
  let liquidations = 0;
  let saved;
  const result = await reconcilePaidRecord({
    state: 'ready', invoiceId: '11518', bank: 'itau', amount: 200
  }, {
    bank: 'itau', paidAt: '2026-09-29', paidAmount: 200
  }, {
    fetchInvoices: async () => ({ invoices: [{
      id: '11518', internalId: 1, status: 1, balance: 0
    }] }),
    liquidate: async () => { liquidations += 1; },
    saveBankSlipRecord: async (_invoiceId, record) => { saved = record; },
    removePending: async () => {},
    markBillingEventCompleted: async () => {}
  });
  assert.equal(result.status, 'already_settled');
  assert.equal(liquidations, 0);
  assert.equal(saved.reconciliation.outcome, 'already_settled');
});

test('consulta liquidações Bradesco em janela D-1 de 60 dias', async () => {
  let criteria;
  const result = await reconcileBankPayments({
    currentDate: '2026-09-30',
    maxRecords: 1
  }, {
    listBankSlipRecords: async () => [{
      state: 'ready', invoiceId: '11777', bank: 'bradesco', ourNumber: '00000021311', amount: 100
    }],
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async () => {},
    bradescoConfig: {},
    listBradescoSettledBankSlips: async (received) => {
      criteria = received;
      return [];
    }
  });
  assert.deepEqual(criteria, {
    paymentDateFrom: '2026-08-01',
    paymentDateTo: '2026-09-29'
  });
  assert.equal(result.pending, 1);
});
