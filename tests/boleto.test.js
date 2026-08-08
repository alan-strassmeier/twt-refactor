const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENVIRONMENTS,
  c6Config,
  requestAccessToken,
  resetTokenCache
} = require('../server/faturamento/c6');
const {
  externalReferenceForInvoice,
  payerFromCompany,
  resolveInvoiceBillingData,
  bankSlipPayload,
  generateInvoiceBankSlip
} = require('../server/faturamento/boleto');

const twtInvoice = {
  fatura: 11518,
  cnpj_cliente: '28.759.933/0001-86',
  status: '0',
  valor: '1844.00',
  emissao: '2026-08-03',
  data_vencimento: '2026-08-14'
};

const payerCompany = {
  cnpj: '28759933000186',
  razao: 'TWT AIRPACK SERVICOS AUXILIARES DE TRANSPORTE AEREO LTDA ME',
  endereco: 'AVENIDA DAS EMPRESAS MUITO COMPRIDA PARA O LIMITE DO BANCO',
  numero: '123',
  complemento: 'SALA 4',
  cidade: 'PORTO ALEGRE',
  uf: 'RS',
  cep: '91000-000',
  email: 'financeiro@example.com'
};

const billingDependencies = (issuerCnpj = '09123137000108') => ({
  requestExactInvoice: async () => ({ invoice: twtInvoice }),
  findDoccobForInvoice: async () => ({
    invoice: { issuerCnpj, dueAt: '2026-08-14' },
    transports: []
  }),
  fetchCompany: async () => payerCompany,
  now: new Date('2026-08-08T12:00:00Z')
});

test('configura hosts e carteiras oficiais separados para sandbox e produção', () => {
  const common = {
    C6_CLIENT_ID: 'client-id',
    C6_CLIENT_SECRET: 'client-secret',
    C6_MTLS_CERT_BASE64: Buffer.from('certificado').toString('base64'),
    C6_MTLS_KEY_BASE64: Buffer.from('chave').toString('base64')
  };
  const sandbox = c6Config({ ...common, C6_ENVIRONMENT: 'sandbox' });
  const production = c6Config({ ...common, C6_ENVIRONMENT: 'production' });

  assert.equal(sandbox.baseUrl, ENVIRONMENTS.sandbox.baseUrl);
  assert.equal(sandbox.billingScheme, '21');
  assert.equal(production.baseUrl, ENVIRONMENTS.production.baseUrl);
  assert.equal(production.billingScheme, '15');
});

test('autentica no C6 com client_credentials e certificado mTLS', async () => {
  resetTokenCache();
  const config = c6Config({
    C6_ENVIRONMENT: 'sandbox',
    C6_CLIENT_ID: 'client-id',
    C6_CLIENT_SECRET: 'client-secret',
    C6_MTLS_CERT_BASE64: Buffer.from('certificado').toString('base64'),
    C6_MTLS_KEY_BASE64: Buffer.from('chave').toString('base64')
  });
  const result = await requestAccessToken(config, async (request) => {
    assert.equal(request.url, 'https://baas-api-sandbox.c6bank.info/v1/auth/');
    assert.equal(request.method, 'POST');
    assert.equal(request.config.cert.toString(), 'certificado');
    const body = new URLSearchParams(request.body);
    assert.equal(body.get('client_id'), 'client-id');
    assert.equal(body.get('client_secret'), 'client-secret');
    assert.equal(body.get('grant_type'), 'client_credentials');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        access_token: 'token-seguro',
        expires_in: 300,
        token_type: 'Bearer'
      }))
    };
  });

  assert.deepEqual(result, { token: 'token-seguro', expiresIn: 300 });
});

test('normaliza o pagador conforme limites obrigatórios da API C6', () => {
  const payer = payerFromCompany(payerCompany);
  assert.equal(payer.name.length, 40);
  assert.equal(payer.tax_id, '28759933000186');
  assert.equal(payer.address.number, 123);
  assert.equal(payer.address.zip_code, '91000000');
  assert.equal(payer.address.street.length + String(payer.address.number).length <= 40, true);
  assert.equal(payer.email, 'financeiro@example.com');
});

test('gera referência externa determinística com no máximo dez caracteres', () => {
  assert.equal(externalReferenceForInvoice('11518'), 'TWT11518');
  const long = externalReferenceForInvoice('12345678901234567890');
  assert.match(long, /^TWT[A-F0-9]{7}$/);
  assert.equal(long.length, 10);
});

test('resolve cobrança somente quando o DOCCOB confirma emitente TWT', async () => {
  const billing = await resolveInvoiceBillingData('11518', billingDependencies());
  assert.equal(billing.invoiceId, '11518');
  assert.equal(billing.issuerCnpj, '09123137000108');
  assert.equal(billing.amount, 1844);
  assert.equal(billing.dueAt, '2026-08-14');

  await assert.rejects(
    resolveInvoiceBillingData('11518', billingDependencies('97434690000129')),
    (error) => error.statusCode === 403 && /somente para faturas emitidas pela TWT/.test(error.message)
  );
});

test('bloqueia fatura vencida até a data ser corrigida na Brudam', async () => {
  await assert.rejects(
    resolveInvoiceBillingData('11518', {
      ...billingDependencies(),
      now: new Date('2026-08-20T12:00:00Z')
    }),
    (error) => error.statusCode === 422 && /Atualize o vencimento na Brudam/.test(error.message)
  );
});

test('monta a emissão com carteira do ambiente e sem seleção de outro banco', async () => {
  const billing = await resolveInvoiceBillingData('11518', billingDependencies());
  const payload = bankSlipPayload(billing, { billingScheme: '21' });
  assert.deepEqual(Object.keys(payload).sort(), [
    'amount',
    'billing_scheme',
    'due_date',
    'external_reference_id',
    'instructions',
    'payer'
  ]);
  assert.equal(payload.billing_scheme, '21');
  assert.equal(payload.external_reference_id, 'TWT11518');
});

test('emite uma única vez e reaproveita o boleto registrado no Redis', async () => {
  let record = null;
  let createCalls = 0;
  const dependencies = {
    ...billingDependencies(),
    getBankSlipRecord: async () => record,
    claimBankSlip: async (invoiceId, processing) => {
      assert.equal(invoiceId, '11518');
      if (record) return false;
      record = processing;
      return true;
    },
    saveBankSlipRecord: async (_invoiceId, value) => { record = value; },
    releaseBankSlipClaim: async () => { record = null; },
    c6Config: () => ({ billingScheme: '21' }),
    createC6BankSlip: async (payload) => {
      createCalls += 1;
      assert.equal(payload.external_reference_id, 'TWT11518');
      return {
        id: '01J3NCKY6Q99QC4D7T733D35QD',
        amount: 1844,
        due_date: '2026-08-14',
        digitable_line: '33690.00009 00000.000000 00000.000000 0 00000000184400',
        bar_code: '33690000000001844000000000000000000000000000'
      };
    }
  };

  const first = await generateInvoiceBankSlip('11518', dependencies);
  const second = await generateInvoiceBankSlip('11518', dependencies);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.status, 'ready');
  assert.equal(createCalls, 1);
});

test('mantém bloqueio para conferência quando a resposta bancária é incerta', async () => {
  let record = null;
  const dependencies = {
    ...billingDependencies(),
    getBankSlipRecord: async () => record,
    claimBankSlip: async (_invoiceId, processing) => {
      record = processing;
      return true;
    },
    saveBankSlipRecord: async (_invoiceId, value) => { record = value; },
    releaseBankSlipClaim: async () => { record = null; },
    c6Config: () => ({ billingScheme: '21' }),
    createC6BankSlip: async () => {
      throw Object.assign(new Error('timeout'), {
        statusCode: 504,
        ambiguousBankState: true
      });
    }
  };

  await assert.rejects(generateInvoiceBankSlip('11518', dependencies), /timeout/);
  assert.equal(record.state, 'review');
});
