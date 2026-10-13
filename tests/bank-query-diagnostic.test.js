const test = require('node:test');
const assert = require('node:assert/strict');

const {
  brudamConfigurationStatus,
  runBankQueryDiagnostic
} = require('../server/faturamento/bank-query-diagnostic');

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
