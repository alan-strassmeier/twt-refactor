const test = require('node:test');
const assert = require('node:assert/strict');

const {
  brudamConfigurationStatus,
  diagnoseItauDetailQuery,
  runBankQueryDiagnostic
} = require('../server/faturamento/bank-query-diagnostic');

test('diagnóstico v2 lê um boleto registrado e devolve somente metadados', async () => {
  let criteria;
  const result = await diagnoseItauDetailQuery({}, {
    itauConfig: { beneficiaryId: '150000052061', wallet: '109' },
    listBankSlipRecords: async () => [{
      state: 'ready', bank: 'itau', invoiceId: '11840',
      beneficiaryId: '150000052061', wallet: '109', ourNumber: '00017244',
      createdAt: '2026-10-10T12:00:00.000Z'
    }],
    queryItauBankSlipDetail: async (input) => {
      criteria = input;
      return { upstreamStatus: 200, data: [{
        dado_boleto: {
          dados_individuais_boleto: [{ situacao_geral_boleto: 'Baixado' }],
          pagamentos_cobranca: [{ valor_pago_total_cobranca: '200.00' }]
        }
      }] };
    }
  });
  assert.deepEqual(criteria, {
    beneficiaryId: '150000052061', wallet: '109', ourNumber: '00017244'
  });
  assert.deepEqual(result, {
    ok: true,
    bank: 'itau',
    operation: 'GET /boletoscash/v2/boletos',
    invoiceId: '11840',
    upstreamStatus: 200,
    records: 1,
    statuses: ['Baixado'],
    statusFieldsPresent: true,
    paymentEntries: 1
  });
  assert.equal(JSON.stringify(result).includes('00017244'), false);
  assert.equal(JSON.stringify(result).includes('200.00'), false);
});

test('diagnóstico v2 consulta somente a fatura Itaú solicitada', async () => {
  let queriedInvoiceId;
  let ourNumber;
  const result = await diagnoseItauDetailQuery({ invoiceId: '11838' }, {
    itauConfig: { beneficiaryId: '060200166662', wallet: '109' },
    getBankSlipRecord: async (invoiceId) => {
      queriedInvoiceId = invoiceId;
      return {
        state: 'ready', bank: 'itau', beneficiaryId: '060200166662',
        wallet: '109', ourNumber: '00011838'
      };
    },
    listBankSlipRecords: async () => { throw new Error('Não deve varrer outros boletos.'); },
    queryItauBankSlipDetail: async (criteria) => {
      ourNumber = criteria.ourNumber;
      return { upstreamStatus: 200, data: [] };
    }
  });
  assert.equal(queriedInvoiceId, '11838');
  assert.equal(ourNumber, '00011838');
  assert.equal(result.invoiceId, '11838');
  assert.equal(result.records, 0);
});

test('diagnóstico v2 distingue amostra ausente de bloqueio HTTP 403', async () => {
  const config = { beneficiaryId: '150000052061', wallet: '109' };
  const noSample = await diagnoseItauDetailQuery({}, {
    itauConfig: config,
    listBankSlipRecords: async () => []
  });
  assert.equal(noSample.reason, 'no_registered_sample');

  const forbidden = await diagnoseItauDetailQuery({}, {
    itauConfig: config,
    listBankSlipRecords: async () => [{
      state: 'ready', bank: 'itau', beneficiaryId: '150000052061',
      wallet: '109', ourNumber: '00017244'
    }],
    queryItauBankSlipDetail: async () => {
      throw Object.assign(new Error('Dados sensíveis do banco'), { upstreamStatus: 403 });
    }
  });
  assert.equal(forbidden.reason, 'forbidden');
  assert.equal(forbidden.upstreamStatus, 403);
  assert.equal(JSON.stringify(forbidden).includes('Dados sensíveis'), false);
});

test('diagnóstico consulta apenas leitura no Itaú e no Bradesco', async () => {
  const calls = {};
  const result = await runBankQueryDiagnostic({
    now: new Date('2026-09-30T15:00:00.000Z')
  }, {
    env: {
      BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID: '2',
      BRUDAM_ITAU_BANK_ACCOUNT_ID: '16666',
      BRUDAM_BRADESCO_BANK_ACCOUNT_ID: '321'
    },
    itauConfig: { beneficiaryId: '060200166662', wallet: '109' },
    bradescoConfig: { environment: 'production' },
    queryItauBankSlips: async (criteria, options) => {
      calls.itau = { criteria, options };
      return [{ ourNumber: '00011841' }];
    },
    listBradescoSettledBankSlips: async (criteria, options) => {
      calls.bradesco = { criteria, options };
      return [];
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(calls.itau.criteria, {
    beneficiaryId: '060200166662',
    wallet: '109',
    inclusionDate: '2026-09-30',
    view: 'basic'
  });
  assert.deepEqual(calls.bradesco.criteria, {
    paymentDateFrom: '2026-09-29',
    paymentDateTo: '2026-09-29'
  });
  assert.equal(calls.bradesco.options.maxPages, 1);
  assert.equal(result.banks.itau.records, 1);
  assert.equal(result.banks.bradesco.records, 0);
  assert.deepEqual(result.brudamConfiguration, {
    paymentMethod: true,
    itauAccount: true,
    bradescoAccount: true
  });
  assert.equal(JSON.stringify(result).includes('060200166662'), false);
});

test('falha de um banco não impede o diagnóstico do outro nem expõe configuração', async () => {
  const result = await runBankQueryDiagnostic({
    now: new Date('2026-09-30T15:00:00.000Z')
  }, {
    env: {},
    itauConfig: { beneficiaryId: '060200166662', wallet: '109', clientSecret: 'segredo' },
    bradescoConfig: { environment: 'production', clientSecret: 'outro-segredo' },
    queryItauBankSlips: async () => {
      throw Object.assign(new Error('Acesso a rota não permitido'), {
        statusCode: 502,
        upstreamStatus: 403
      });
    },
    listBradescoSettledBankSlips: async () => []
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.banks.itau, {
    ok: false,
    message: 'Acesso a rota não permitido',
    upstreamStatus: 403,
    statusCode: 502
  });
  assert.equal(result.banks.bradesco.ok, true);
  assert.equal(JSON.stringify(result).includes('segredo'), false);
});

test('diagnóstico repassa somente a estrutura segura de resposta Itaú inesperada', async () => {
  const shape = {
    upstreamStatus: 200,
    queryHost: 'boleto.api.itau.com',
    contentType: 'application/json',
    rootType: 'object',
    rootFields: ['items'],
    dataType: 'undefined',
    dataLength: null,
    firstItemFields: [],
    pageType: 'undefined',
    pageFields: [],
    paginationType: 'undefined',
    paginationFields: [],
    requestedPage: 0,
    returnedPage: null,
    totalPages: null
  };
  const result = await runBankQueryDiagnostic({
    now: new Date('2026-09-30T15:00:00.000Z')
  }, {
    env: {},
    itauConfig: { beneficiaryId: '060200166662', wallet: '109' },
    bradescoConfig: { environment: 'production' },
    queryItauBankSlips: async () => {
      throw Object.assign(new Error('Formato não reconhecido'), {
        statusCode: 502,
        responseShape: shape
      });
    },
    listBradescoSettledBankSlips: async () => []
  });

  assert.deepEqual(result.banks.itau.responseShape, shape);
  assert.equal(result.banks.bradesco.ok, true);
  assert.equal(JSON.stringify(result).includes('060200166662'), false);
});

test('estado das variáveis da Brudam exige IDs inteiros positivos', () => {
  assert.deepEqual(brudamConfigurationStatus({
    BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID: '2',
    BRUDAM_ITAU_BANK_ACCOUNT_ID: '0',
    BRUDAM_BRADESCO_BANK_ACCOUNT_ID: 'conta'
  }), {
    paymentMethod: true,
    itauAccount: false,
    bradescoAccount: false
  });
});
