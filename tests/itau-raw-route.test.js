const test = require('node:test');
const assert = require('node:assert/strict');

const { createHandler } = require('../api/faturamento/itau-raw');

const response = () => {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; }
  };
};

const request = (id = '11817', method = 'GET') => ({
  method,
  url: `/api/faturamento/itau-raw?id=${id}`,
  headers: { host: 'preview.example.test' }
});

const dependencies = (overrides = {}) => ({
  env: { VERCEL_ENV: 'preview' },
  now: () => Date.parse('2026-10-16T18:00:00Z'),
  sessionFromRequest: () => ({ sub: 'admin' }),
  itauBoletoConfig: () => ({ beneficiaryId: '060200166662', wallet: '109' }),
  getBankSlipRecord: async () => ({
    invoiceId: '11817',
    state: 'ready',
    bank: 'itau',
    beneficiaryId: '060200166662',
    wallet: '109',
    ourNumber: '00011817'
  }),
  queryItauBankSlipDetail: async () => ({
    upstreamStatus: 200,
    raw: { data: [{
      beneficiario: { id_beneficiario: '060200166662' },
      dado_boleto: {
        codigo_carteira: '109',
        dados_individuais_boleto: [{ numero_nosso_numero: '00011817' }]
      }
    }], page: { totalElements: 1 } }
  }),
  ...overrides
});

test('diagnóstico bruto Itaú não existe fora de preview', async () => {
  const handler = createHandler(dependencies({ env: { VERCEL_ENV: 'production' } }));
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
});

test('diagnóstico bruto expira mesmo em deployments antigos', async () => {
  const handler = createHandler(dependencies({
    now: () => Date.parse('2026-10-18T00:00:00Z')
  }));
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
});

test('diagnóstico bruto exige sessão e permite apenas GET', async () => {
  const queryBank = () => { throw new Error('Banco não deveria ser consultado.'); };
  const unauthenticated = createHandler(dependencies({
    sessionFromRequest: () => null,
    queryItauBankSlipDetail: queryBank
  }));
  const denied = response();
  await unauthenticated(request(), denied);
  assert.equal(denied.statusCode, 401);

  const authenticated = createHandler(dependencies({ queryItauBankSlipDetail: queryBank }));
  const wrongMethod = response();
  await authenticated(request('11817', 'POST'), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'GET');
});

test('diagnóstico bruto só aceita as duas faturas especificadas', async () => {
  const handler = createHandler(dependencies());
  const res = response();
  await handler(request('11819'), res);
  assert.equal(res.statusCode, 404);
});

test('diagnóstico bruto exige registro Itaú correspondente', async () => {
  const handler = createHandler(dependencies({
    getBankSlipRecord: async () => ({ state: 'ready', bank: 'bradesco' }),
    queryItauBankSlipDetail: () => { throw new Error('Banco não deveria ser consultado.'); }
  }));
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
});

test('diagnóstico bruto devolve o JSON integral do boleto correspondente', async () => {
  let criteria;
  let options;
  const bankQuery = dependencies().queryItauBankSlipDetail;
  const handler = createHandler(dependencies({
    queryItauBankSlipDetail: async (input, settings) => {
      criteria = input;
      options = settings;
      return bankQuery();
    }
  }));
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.deepEqual(criteria, {
    beneficiaryId: '060200166662', wallet: '109', ourNumber: '00011817'
  });
  assert.equal(options.includeRaw, true);
  assert.deepEqual(JSON.parse(res.body), {
    readOnly: true,
    invoiceId: '11817',
    upstreamStatus: 200,
    response: {
      data: [{
        beneficiario: { id_beneficiario: '060200166662' },
        dado_boleto: {
          codigo_carteira: '109',
          dados_individuais_boleto: [{ numero_nosso_numero: '00011817' }]
        }
      }],
      page: { totalElements: 1 }
    }
  });
});

test('diagnóstico bruto não divulga resposta de outro título', async () => {
  const handler = createHandler(dependencies({
    queryItauBankSlipDetail: async () => ({
      upstreamStatus: 200,
      raw: { data: [{
        beneficiario: { id_beneficiario: '060200166662' },
        dado_boleto: {
          codigo_carteira: '109',
          dados_individuais_boleto: [{ numero_nosso_numero: '00011838' }]
        }
      }] }
    })
  }));
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).response, undefined);
});
