const test = require('node:test');
const assert = require('node:assert/strict');

const {
  brudamLiquidationSettings,
  itauSettlementForRecord,
  itauReconciliationAllowlist,
  reconcilePaidRecord,
  reconcileBankPayments
} = require('../server/faturamento/bank-payment-reconciliation');

const itauDetail = ({
  status = 'Paga', amount = '200.00', paymentAmounts = ['200.00'],
  beneficiaryId = '150000052061', wallet = '109', ourNumber = '11518',
  payerTaxId = '33378996846', dueAt = '2026-10-10', yourNumber = 'FAT11518',
  paymentDate = '2026-09-29'
} = {}) => ({
  upstreamStatus: 200,
  data: [{
    id_boleto: '37393662-6632-3261-2d30-6662632d3464',
    beneficiario: { id_beneficiario: beneficiaryId },
    dado_boleto: {
      codigo_carteira: wallet,
      pagador: { pessoa: { tipo_pessoa: {
        numero_cadastro_nacional_pessoa_juridica: payerTaxId
      } } },
      dados_individuais_boleto: [{
        numero_nosso_numero: ourNumber,
        texto_seu_numero: yourNumber,
        data_vencimento: dueAt,
        valor_titulo: amount,
        situacao_geral_boleto: status
      }],
      pagamentos_cobranca: paymentAmounts.map((paid) => ({
        valor_pago_total_cobranca: paid,
        data_inclusao_pagamento: paymentDate
      }))
    }
  }]
});

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
  const record = {
    state: 'ready',
    invoiceId: '11777',
    bank: 'bradesco',
    bankSlipId: '00000021311',
    ourNumber: '00000021311',
    amount: 100
  };
  const result = await reconcilePaidRecord(record, {
    bank: 'bradesco',
    paidAt: '2026-09-29',
    paidAmount: 103,
    reference: '00000021311',
    titleAmounts: [100],
    payerTaxIds: []
  }, {
    claimReconciliationLock: async () => 'lock-token',
    releaseReconciliationLock: async () => {},
    getBankSlipRecord: async () => record,
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
  assert.equal(calls.saved[0].reconciliation.status, 'submission_pending');
  assert.equal(calls.saved.at(-1).reconciliation.status, 'completed');
  assert.equal(calls.saved.at(-1).reconciliation.outcome, 'liquidated');
  assert.deepEqual(calls.removed, ['11777']);
  assert.deepEqual(calls.completed.sort(), ['initial', 'overdue', 'reminder']);
});

test('rotina Itaú não baixa boleto que não está marcado como pago', async () => {
  let liquidations = 0;
  let savedCursor = null;
  const result = await reconcileBankPayments({
    currentDate: '2026-09-30',
    maxRecords: 8
  }, {
    env: { ITAU_RECONCILIATION_INVOICE_IDS: '11518' },
    listBankSlipRecords: async () => [{
      state: 'ready',
      invoiceId: '11518',
      bank: 'itau',
      bankSlipId: '15000005206110900011518',
      beneficiaryId: '150000052061',
      wallet: '109',
      ourNumber: '00011518',
      amount: 200,
      payer: { tax_id: '33378996846' },
      createdAt: '2026-09-20T12:00:00.000Z'
    }],
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async (cursor) => { savedCursor = cursor; },
    itauConfig: {
      beneficiaryId: '150000052061',
      wallet: '109'
    },
    queryItauBankSlipDetail: async (criteria) => {
      assert.deepEqual(criteria, {
        beneficiaryId: '150000052061',
        wallet: '109',
        ourNumber: '00011518'
      });
      return itauDetail({ status: 'Em Aberto', paymentAmounts: [] });
    },
    liquidate: async () => { liquidations += 1; }
  });
  assert.equal(result.checked, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.settled, 0);
  assert.equal(liquidations, 0);
  assert.equal(savedCursor, 0);
});

test('boleto Itaú pago usa o valor e a data dos pagamentos retornados pela v2', async () => {
  const settlement = await itauSettlementForRecord({
      invoiceId: '11518',
      beneficiaryId: '150000052061',
      wallet: '109',
      ourNumber: '00011518',
      amount: 200,
      payer: { tax_id: '33378996846' },
      createdAt: '2026-09-20T12:00:00.000Z'
    }, {
      currentDate: '2026-09-30',
      itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
      queryItauBankSlipDetail: async () => itauDetail({
        paymentAmounts: ['125.00', '80.00']
      })
    });
  assert.deepEqual(settlement, {
    bank: 'itau',
    paidAt: '2026-09-29',
    paidAmount: 205,
    reference: '37393662-6632-3261-2d30-6662632d3464',
    beneficiaryId: '150000052061',
    wallet: '109',
    ourNumber: '00011518',
    payerTaxId: '33378996846',
    paidAtSource: 'itau_v2_payment_inclusion',
    paidAmountSource: 'itau_v2_payments',
    bankStatus: 'pago'
  });
});

test('rodada Itaú baixa boleto na data informada pelo banco e registra a origem', async () => {
  let record = {
    state: 'ready', invoiceId: '11518', bank: 'itau', amount: 200,
    bankSlipId: '15000005206110900011518',
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518',
    payer: { tax_id: '33378996846' },
    createdAt: '2026-09-20T12:00:00.000Z'
  };
  let request;
  const result = await reconcileBankPayments({ currentDate: '2026-09-30' }, {
    env: { ITAU_RECONCILIATION_INVOICE_IDS: '11518' },
    listBankSlipRecords: async () => [record],
    getBankSlipRecord: async () => record,
    saveBankSlipRecord: async (_invoiceId, updated) => { record = updated; },
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async () => {},
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail(),
    fetchInvoices: async () => ({ invoices: [{
      id: '11518', internalId: 12, status: 0, balance: 200
    }] }),
    liquidationSettings: () => ({ paymentMethodId: 7, bankAccountId: 321 }),
    liquidate: async (_path, body) => {
      request = body;
      return {
        response: { ok: true },
        payload: { status: 1, data: { status: 1, ids: [12] } }
      };
    },
    removePending: async () => {},
    markBillingEventCompleted: async () => {}
  });
  assert.equal(result.settled, 1);
  assert.equal(request.documentos[0].data_pagamento, '2026-09-29');
  assert.equal(request.documentos[0].data_credito_debito, '2026-09-29');
  assert.equal(request.documentos[0].valor_liquidado, 200);
  assert.equal(record.reconciliation.paidAtSource, 'itau_v2_payment_inclusion');
  assert.equal(record.reconciliation.paidAmountSource, 'itau_v2_payments');
  assert.equal(record.reconciliation.bankReference, '37393662-6632-3261-2d30-6662632d3464');
});

test('liberação Itaú fica restrita às faturas escolhidas até ativação explícita de todas', async () => {
  assert.deepEqual([...itauReconciliationAllowlist({})], []);
  assert.deepEqual([...itauReconciliationAllowlist({
    ITAU_RECONCILIATION_INVOICE_IDS: '11838, 11817'
  })], ['11838', '11817']);
  assert.equal(itauReconciliationAllowlist({ ITAU_RECONCILIATION_INVOICE_IDS: '*' }), null);
  assert.throws(() => itauReconciliationAllowlist({
    ITAU_RECONCILIATION_INVOICE_IDS: '11838,*'
  }), /deve conter números/);
  let bankQueries = 0;
  const result = await reconcileBankPayments({ currentDate: '2026-10-16' }, {
    env: { ITAU_RECONCILIATION_INVOICE_IDS: '11817,11838' },
    listBankSlipRecords: async () => ['11817', '11838', '11840'].map((invoiceId) => ({
      state: 'ready', bank: 'itau', invoiceId
    })),
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async () => {},
    itauConfig: { beneficiaryId: '060200166662', wallet: '109' },
    queryItauBankSlipDetail: async () => { bankQueries += 1; return { data: [] }; }
  });
  assert.equal(result.checked, 2);
  assert.equal(bankQueries, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((item) => item.invoiceId !== '11840'));
});

test('Itaú não baixa se o valor nominal ou pagador divergir do boleto emitido', async () => {
  const record = {
    invoiceId: '11518', beneficiaryId: '150000052061', wallet: '109',
    ourNumber: '00011518', amount: 200, payer: { tax_id: '33378996846' },
    createdAt: '2026-09-20T12:00:00.000Z'
  };
  await assert.rejects(itauSettlementForRecord(record, {
    currentDate: '2026-09-30',
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail({ amount: '190.00' })
  }), /valor original/);
  await assert.rejects(itauSettlementForRecord(record, {
    currentDate: '2026-09-30',
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail({ payerTaxId: '12345678901' })
  }), /pagador/);
});

test('simulações das faturas 11817 e 11838 exigem pagamento v2 integral', async () => {
  for (const { invoiceId, amount, payerTaxId } of [
    { invoiceId: '11817', amount: 1727.33, payerTaxId: '02663553000150' },
    { invoiceId: '11838', amount: 128.81, payerTaxId: '35640442000187' }
  ]) {
    const ourNumber = invoiceId.padStart(8, '0');
    const record = {
      invoiceId, bank: 'itau', amount,
      beneficiaryId: '060200166662', wallet: '109', ourNumber,
      payer: { tax_id: payerTaxId }, issuedAt: '2026-09-25'
    };
    const settlement = await itauSettlementForRecord(record, {
      currentDate: '2026-10-16',
      itauConfig: { beneficiaryId: '060200166662', wallet: '109' },
      queryItauBankSlipDetail: async (criteria) => {
        assert.equal(criteria.ourNumber, ourNumber);
        return itauDetail({
          beneficiaryId: '060200166662', ourNumber: invoiceId, payerTaxId,
          amount: amount.toFixed(2), paymentAmounts: [amount.toFixed(2)],
          paymentDate: '2026-10-13T16:48:37'
        });
      }
    });
    assert.equal(settlement.paidAmount, amount);
    assert.equal(settlement.paidAmountSource, 'itau_v2_payments');
    assert.equal(settlement.paidAt, '2026-10-13');
    assert.equal(settlement.paidAtSource, 'itau_v2_payment_inclusion');
  }
});

test('fatura 11838 usa a data e o valor bancários na baixa simulada, uma única vez', async () => {
  let record = {
    state: 'ready', invoiceId: '11838', bank: 'itau', amount: 128.81,
    beneficiaryId: '060200166662', wallet: '109', ourNumber: '00011838',
    payer: { tax_id: '35640442000187' }, issuedAt: '2026-09-28',
    dueAt: '2026-10-13', yourNumber: 'FAT11838'
  };
  const requests = [];
  const dependencies = {
    env: { ITAU_RECONCILIATION_INVOICE_IDS: '11838' },
    listBankSlipRecords: async () => [record],
    getBankSlipRecord: async () => record,
    saveBankSlipRecord: async (_invoiceId, updated) => { record = updated; },
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async () => {},
    itauConfig: { beneficiaryId: '060200166662', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail({
      beneficiaryId: '060200166662', wallet: '109', ourNumber: '11838',
      payerTaxId: '35640442000187', amount: '128.81',
      paymentAmounts: ['128.81'], paymentDate: '2026-10-13T11:44:37',
      dueAt: '2026-10-13', yourNumber: 'FAT11838'
    }),
    fetchInvoices: async () => ({ invoices: [{
      id: '11838', internalId: 42, status: 0, balance: 128.81
    }] }),
    liquidationSettings: () => ({ paymentMethodId: 7, bankAccountId: 321 }),
    liquidate: async (path, body) => {
      requests.push({ path, body });
      return { response: { ok: true }, payload: {
        status: 1, data: { status: 1, ids: [42] }
      } };
    },
    removePending: async () => {},
    markBillingEventCompleted: async () => {}
  };
  const first = await reconcileBankPayments({ currentDate: '2026-10-16' }, dependencies);
  const second = await reconcileBankPayments({ currentDate: '2026-10-16' }, dependencies);
  assert.equal(first.settled, 1);
  assert.equal(second.checked, 0);
  assert.deepEqual(requests, [{
    path: '/financeiro/liquidar/lancamento',
    body: { documentos: [{
      id_lancamento: 42, data_pagamento: '2026-10-13', forma_pagamento: 7,
      data_credito_debito: '2026-10-13', valor_juros: 0,
      valor_liquidado: 128.81, conta_bancaria: 321
    }] }
  }]);
});

test('Itaú não baixa pagamento parcial, ausente ou malformado mesmo com status Paga', async () => {
  const record = {
    invoiceId: '11518', beneficiaryId: '150000052061', wallet: '109',
    ourNumber: '00011518', amount: 200, payer: { tax_id: '33378996846' },
    issuedAt: '2026-09-20'
  };
  const run = (paymentAmounts) => itauSettlementForRecord(record, {
    currentDate: '2026-09-30',
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail({ paymentAmounts })
  });
  await assert.rejects(run(['100.00']), /não cobrem integralmente/);
  await assert.rejects(run([]), /não retornou lançamentos/);
  await assert.rejects(run(['200.00', 'inválido']), /sem valor válido/);
  await assert.rejects(itauSettlementForRecord(record, {
    currentDate: '2026-09-30',
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail({ paymentDate: '2026-13-44' })
  }), /sem data ou valor consistente/);
  await assert.rejects(itauSettlementForRecord(record, {
    currentDate: '2026-09-30',
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail({ paymentDate: '2026-10-01' })
  }), /fora do período/);
  await assert.rejects(itauSettlementForRecord(record, {
    currentDate: '2026-09-30',
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    queryItauBankSlipDetail: async () => itauDetail({ paymentDate: '2026-09-19' })
  }), /fora do período/);
});

test('Itaú não atribui pagamentos de outro título ou boleto parcelado à fatura', async () => {
  const record = {
    invoiceId: '11518', beneficiaryId: '150000052061', wallet: '109',
    ourNumber: '00011518', amount: 200, payer: { tax_id: '33378996846' },
    issuedAt: '2026-09-20'
  };
  const base = {
    currentDate: '2026-09-30',
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' }
  };
  await assert.rejects(itauSettlementForRecord(record, {
    ...base,
    queryItauBankSlipDetail: async () => itauDetail({ ourNumber: '00099999' })
  }), /não corresponde ao boleto registrado/);
  await assert.rejects(itauSettlementForRecord(record, {
    ...base,
    queryItauBankSlipDetail: async () => {
      const result = itauDetail();
      result.data[0].dado_boleto.dados_individuais_boleto.push({
        numero_nosso_numero: '00099999'
      });
      return result;
    }
  }), /várias parcelas/);
});

test('evidência antiga da v1 não pode iniciar nova baixa na Brudam', async () => {
  const record = {
    state: 'ready', invoiceId: '11518', bank: 'itau', amount: 200,
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518'
  };
  let posts = 0;
  await assert.rejects(reconcilePaidRecord(record, {
    bank: 'itau', paidAt: '2026-09-30', paidAmount: 200,
    beneficiaryId: record.beneficiaryId, wallet: record.wallet,
    ourNumber: record.ourNumber, bankStatus: 'pago',
    paidAtSource: 'itau_v2_payment_inclusion', paidAmountSource: 'boleto_nominal'
  }, {
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getBankSlipRecord: async () => record,
    fetchInvoices: async () => ({ invoices: [{
      id: '11518', internalId: 12, status: 0, balance: 200
    }] }),
    liquidate: async () => { posts += 1; }
  }), /consulta detalhada v2/);
  assert.equal(posts, 0);
});

test('Itaú não cria juros presumidos quando o saldo Brudam difere do valor nominal', async () => {
  const record = {
    state: 'ready', invoiceId: '11518', bank: 'itau', amount: 200,
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518'
  };
  let liquidations = 0;
  await assert.rejects(reconcilePaidRecord(record, {
    bank: 'itau', paidAt: '2026-09-30', paidAmount: 200,
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518',
    bankStatus: 'pago', paidAtSource: 'itau_v2_payment_inclusion', paidAmountSource: 'itau_v2_payments'
  }, {
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getBankSlipRecord: async () => record,
    fetchInvoices: async () => ({ invoices: [{
      id: '11518', internalId: 12, status: 0, balance: 180
    }] }),
    liquidationSettings: () => ({ paymentMethodId: 7, bankAccountId: 321 }),
    liquidate: async () => { liquidations += 1; }
  }), /saldo da fatura difere/);
  assert.equal(liquidations, 0);
});

test('fatura já liquidada é encerrada sem repetir POST na Brudam', async () => {
  let liquidations = 0;
  let saved;
  const record = {
    state: 'ready', invoiceId: '11518', bank: 'itau', amount: 200,
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518'
  };
  const result = await reconcilePaidRecord(record, {
    bank: 'itau', paidAt: '2026-09-29', paidAmount: 200,
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518',
    bankStatus: 'pago', paidAtSource: 'itau_v2_payment_inclusion', paidAmountSource: 'itau_v2_payments'
  }, {
    claimReconciliationLock: async () => 'lock-token',
    releaseReconciliationLock: async () => {},
    getBankSlipRecord: async () => record,
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

test('fatura cancelada com saldo zero nunca é tratada como liquidada', async () => {
  const record = {
    state: 'ready', invoiceId: '11518', bank: 'itau', amount: 200,
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518'
  };
  let liquidations = 0;
  await assert.rejects(reconcilePaidRecord(record, {
    bank: 'itau', paidAt: '2026-09-29', paidAmount: 200,
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00011518',
    bankStatus: 'pago', paidAtSource: 'itau_v2_payment_inclusion', paidAmountSource: 'itau_v2_payments'
  }, {
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getBankSlipRecord: async () => record,
    fetchInvoices: async () => ({ invoices: [{ id: '11518', status: 2, balance: 0 }] }),
    liquidate: async () => { liquidations += 1; }
  }), /não está aberta/);
  assert.equal(liquidations, 0);
});

test('resposta incerta da Brudam bloqueia outro POST e conclui após confirmação da baixa', async () => {
  let record = {
    state: 'ready', invoiceId: '11777', bank: 'bradesco',
    ourNumber: '00000021311', amount: 100
  };
  const settlement = {
    bank: 'bradesco', reference: '00000021311', paidAt: '2026-09-29',
    paidAmount: 100, titleAmounts: [100], payerTaxIds: []
  };
  let liquidations = 0;
  let settled = false;
  const dependencies = {
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getBankSlipRecord: async () => record,
    saveBankSlipRecord: async (_invoiceId, updated) => { record = updated; },
    fetchInvoices: async () => ({ invoices: [{
      id: '11777', internalId: 12, status: settled ? 1 : 0, balance: settled ? 0 : 100
    }] }),
    liquidationSettings: () => ({ paymentMethodId: 7, bankAccountId: 321 }),
    liquidate: async () => {
      liquidations += 1;
      throw new Error('Timeout após envio do POST');
    },
    removePending: async () => {},
    markBillingEventCompleted: async () => {}
  };
  await assert.rejects(reconcilePaidRecord(record, settlement, dependencies), /Timeout/);
  assert.equal(record.reconciliation.status, 'submission_pending');
  await assert.rejects(reconcilePaidRecord(record, settlement, dependencies), /Confira manualmente/);
  assert.equal(liquidations, 1);
  settled = true;
  const result = await reconcilePaidRecord(record, settlement, dependencies);
  assert.equal(result.status, 'already_settled');
  assert.equal(record.reconciliation.status, 'completed');
  assert.equal(liquidations, 1);
});

test('lock de conciliação ocupado impede consultar ou baixar a mesma fatura', async () => {
  let fetched = 0;
  const result = await reconcilePaidRecord({ invoiceId: '11777' }, {}, {
    claimReconciliationLock: async () => null,
    fetchInvoices: async () => { fetched += 1; }
  });
  assert.equal(result.status, 'in_progress');
  assert.equal(fetched, 0);
});

test('Bradesco não baixa boleto com valor original divergente', async () => {
  const record = {
    state: 'ready', invoiceId: '11777', bank: 'bradesco',
    ourNumber: '00000021311', amount: 100
  };
  let fetched = 0;
  await assert.rejects(reconcilePaidRecord(record, {
    bank: 'bradesco', reference: '00000021311', paidAt: '2026-09-29',
    paidAmount: 200, titleAmounts: [200], payerTaxIds: []
  }, {
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getBankSlipRecord: async () => record,
    fetchInvoices: async () => { fetched += 1; }
  }), /valor original/);
  assert.equal(fetched, 0);
});

test('rodada Bradesco liquida uma única vez com evidência bancária completa', async () => {
  let record = {
    state: 'ready', invoiceId: '11777', bank: 'bradesco',
    ourNumber: '00000021311', amount: 100,
    payer: { tax_id: '28759933000186' }
  };
  let liquidations = 0;
  const result = await reconcileBankPayments({ currentDate: '2026-09-30' }, {
    listBankSlipRecords: async () => [record],
    getBankSlipRecord: async () => record,
    saveBankSlipRecord: async (_invoiceId, updated) => { record = updated; },
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async () => {},
    bradescoConfig: {},
    listBradescoSettledBankSlips: async () => [{
      ourNumber: '00000021311', paidAt: '2026-09-29', paidAmount: 101,
      titleAmount: 100, payerTaxId: '28759933000186'
    }],
    fetchInvoices: async () => ({ invoices: [{
      id: '11777', internalId: 12, status: 0, balance: 100
    }] }),
    liquidationSettings: () => ({ paymentMethodId: 7, bankAccountId: 321 }),
    liquidate: async () => {
      liquidations += 1;
      return {
        response: { ok: true },
        payload: { status: 1, data: { status: 1, ids: [12] } }
      };
    },
    removePending: async () => {},
    markBillingEventCompleted: async () => {}
  });
  assert.equal(result.settled, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(liquidations, 1);
  assert.equal(record.reconciliation.status, 'completed');
});

test('Nosso Número Bradesco repetido em outra fatura impede a baixa', async () => {
  let liquidations = 0;
  const result = await reconcileBankPayments({ currentDate: '2026-09-30', maxRecords: 1 }, {
    listBankSlipRecords: async () => [
      { state: 'ready', invoiceId: '11777', bank: 'bradesco', ourNumber: '00000021311' },
      { state: 'ready', invoiceId: '11778', bank: 'bradesco', ourNumber: '00000021311',
        reconciliation: { status: 'completed' } }
    ],
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async () => {},
    bradescoConfig: {},
    listBradescoSettledBankSlips: async () => [],
    liquidate: async () => { liquidations += 1; }
  });
  assert.equal(result.settled, 0);
  assert.match(result.errors[0].message, /mais de uma fatura/);
  assert.equal(liquidations, 0);
});

test('tentativa incerta é reconferida na Brudam sem nova consulta ou POST bancário', async () => {
  let record = {
    state: 'ready', invoiceId: '11777', bank: 'bradesco',
    ourNumber: '00000021311', amount: 100,
    reconciliation: {
      status: 'submission_pending', bank: 'bradesco',
      reference: '00000021311', paidAt: '2026-09-29', paidAmount: 100,
      titleAmounts: [100], payerTaxIds: []
    }
  };
  let bankQueries = 0;
  let liquidations = 0;
  const result = await reconcileBankPayments({ currentDate: '2026-09-30' }, {
    listBankSlipRecords: async () => [record],
    getBankSlipRecord: async () => record,
    saveBankSlipRecord: async (_invoiceId, updated) => { record = updated; },
    claimReconciliationLock: async () => 'token',
    releaseReconciliationLock: async () => {},
    getReconciliationCursor: async () => 0,
    saveReconciliationCursor: async () => {},
    listBradescoSettledBankSlips: async () => { bankQueries += 1; return []; },
    fetchInvoices: async () => ({ invoices: [{ id: '11777', status: 1, balance: 0 }] }),
    liquidate: async () => { liquidations += 1; },
    removePending: async () => {},
    markBillingEventCompleted: async () => {}
  });
  assert.equal(result.alreadySettled, 1);
  assert.equal(record.reconciliation.status, 'completed');
  assert.equal(bankQueries, 0);
  assert.equal(liquidations, 0);
});

test('tentativa Itaú antiga pendente só confere a Brudam e nunca repete a baixa', async () => {
  for (const brudamStatus of [0, 1]) {
    let saved;
    let liquidations = 0;
    const record = {
      state: 'ready', invoiceId: '11838', bank: 'itau', amount: 128.81,
      beneficiaryId: '060200166662', wallet: '109', ourNumber: '00011838',
      reconciliation: {
        status: 'submission_pending', bank: 'itau', paidAt: '2026-10-16',
        paidAmount: 128.81, paidAtSource: 'detection_date',
        paidAmountSource: 'itau_v2_payments'
      }
    };
    const dependencies = {
      claimReconciliationLock: async () => 'token',
      releaseReconciliationLock: async () => {},
      getBankSlipRecord: async () => record,
      fetchInvoices: async () => ({ invoices: [{
        id: '11838', status: brudamStatus, balance: brudamStatus ? 0 : 128.81
      }] }),
      saveBankSlipRecord: async (_invoiceId, updated) => { saved = updated; },
      liquidate: async () => { liquidations += 1; },
      removePending: async () => {},
      markBillingEventCompleted: async () => {}
    };
    if (brudamStatus === 1) {
      const result = await reconcilePaidRecord(record, record.reconciliation, dependencies);
      assert.equal(result.status, 'already_settled');
      assert.equal(saved.reconciliation.status, 'completed');
    } else {
      await assert.rejects(reconcilePaidRecord(record, record.reconciliation, dependencies),
        /Confira manualmente/);
      assert.equal(saved, undefined);
    }
    assert.equal(liquidations, 0);
  }
});
