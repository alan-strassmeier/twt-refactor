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
  itauOurNumberForInvoice,
  itauAmountForPayload,
  itauBankSlipPayload,
  generateInvoiceBankSlip,
  getInvoiceBankSlipPdf
} = require('../server/faturamento/boleto');
const {
  BILLING_BANKS,
  bankSlipBankForIssuer
} = require('../server/faturamento/billing-rules');

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

test('roteia TWT para C6 e DSL para Itaú usando o emitente confirmado no DOCCOB', async () => {
  const billing = await resolveInvoiceBillingData('11518', billingDependencies());
  assert.equal(billing.invoiceId, '11518');
  assert.equal(billing.issuerCnpj, '09123137000108');
  assert.equal(billing.bank, BILLING_BANKS.c6);
  assert.equal(billing.amount, 1844);
  assert.equal(billing.dueAt, '2026-08-14');

  const dslBilling = await resolveInvoiceBillingData(
    '11518',
    billingDependencies('97.434.690/0001-29')
  );
  assert.equal(dslBilling.bank, BILLING_BANKS.itau);
  assert.equal(bankSlipBankForIssuer('97.434.690/0001-29').label, 'Itaú');

  await assert.rejects(
    resolveInvoiceBillingData('11518', billingDependencies('00000000000000')),
    (error) => error.statusCode === 403 && /não possui banco de cobrança/.test(error.message)
  );
});

test('fatura DSL é validada no Itaú sem registrar título nem chamar o C6', async () => {
  let c6Calls = 0;
  let itauCalls = 0;
  const result = await generateInvoiceBankSlip('11518', {
    ...billingDependencies('97434690000129'),
    getBankSlipRecord: async () => null,
    c6Config: () => { c6Calls += 1; },
    createC6BankSlip: async () => { c6Calls += 1; },
    itauBoletoConfig: () => ({
      stage: 'validacao',
      beneficiaryId: '150000052061',
      wallet: '109',
      species: '01',
      acceptance: 'N'
    }),
    createItauBankSlip: async (payload) => {
      itauCalls += 1;
      assert.equal(payload.etapa_processo_boleto, 'validacao');
      return { registered: false, digitableLine: '', barCode: '' };
    }
  });
  assert.equal(result.status, 'validated');
  assert.match(result.message, /Nenhum boleto foi registrado/);
  assert.equal(c6Calls, 0);
  assert.equal(itauCalls, 1);
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

test('monta o boleto Itaú no contrato oficial e com nosso número determinístico', async () => {
  const billing = await resolveInvoiceBillingData(
    '11518',
    billingDependencies('97434690000129')
  );
  const payload = itauBankSlipPayload(billing, {
    stage: 'validacao',
    beneficiaryId: '150000052061',
    wallet: '109',
    species: '01',
    acceptance: 'N'
  });
  const detail = payload.dado_boleto.dados_individuais_boleto[0];
  assert.equal(payload.etapa_processo_boleto, 'validacao');
  assert.equal(payload.codigo_canal_operacao, 'API');
  assert.equal(payload.beneficiario.id_beneficiario, '150000052061');
  assert.equal(payload.dado_boleto.codigo_carteira, '109');
  assert.equal(payload.dado_boleto.pagador.pessoa.tipo_pessoa.codigo_tipo_pessoa, 'J');
  assert.equal(detail.numero_nosso_numero, '00011518');
  assert.equal(detail.texto_seu_numero, 'FAT11518');
  assert.equal(detail.valor_titulo, '00000000000184400');
  assert.equal(detail.data_vencimento, '2026-08-14');
  assert.equal(payload.dado_boleto.desconto_expresso, false);
  assert.equal(itauOurNumberForInvoice('11518'), '00011518');
  assert.equal(itauAmountForPayload(684.44), '00000000000068444');
});

test('efetiva boleto DSL no Itaú uma única vez e armazena dados para o PDF', async () => {
  let record = null;
  let itauCalls = 0;
  const dependencies = {
    ...billingDependencies('97434690000129'),
    getBankSlipRecord: async () => record,
    claimBankSlip: async (_invoiceId, processing) => {
      if (record) return false;
      record = processing;
      return true;
    },
    saveBankSlipRecord: async (_invoiceId, value) => { record = value; },
    releaseBankSlipClaim: async () => { record = null; },
    itauBoletoConfig: () => ({
      stage: 'efetivacao',
      beneficiaryId: '150000052061',
      beneficiaryName: 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA',
      beneficiaryTaxId: '97434690000129',
      wallet: '109',
      species: '01',
      acceptance: 'N'
    }),
    createItauBankSlip: async () => {
      itauCalls += 1;
      return {
        id: 'boleto-itau-11518',
        registered: true,
        amount: 1844,
        dueDate: '2026-08-14',
        wallet: '109',
        ourNumber: '00011518',
        yourNumber: 'FAT11518',
        digitableLine: '34191234567890123456789012345678901234567890123',
        barCode: '34191234567890123456789012345678901234567890'
      };
    }
  };
  const first = await generateInvoiceBankSlip('11518', dependencies);
  const second = await generateInvoiceBankSlip('11518', dependencies);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.bank, 'itau');
  assert.equal(record.beneficiaryId, '150000052061');
  assert.equal(record.payer.tax_id, '28759933000186');
  assert.equal(itauCalls, 1);
});

test('PDF do Itaú é gerado localmente e o PDF do C6 continua vindo do banco', async () => {
  const itauPdf = Buffer.from('%PDF-itau');
  const rendered = await getInvoiceBankSlipPdf('11518', {
    getBankSlipRecord: async () => ({
      state: 'ready',
      bank: 'itau',
      bankSlipId: 'boleto-itau-11518'
    }),
    renderItauBankSlipPdf: async () => itauPdf
  });
  assert.equal(rendered, itauPdf);

  const c6Pdf = Buffer.from('%PDF-c6');
  const downloaded = await getInvoiceBankSlipPdf('11518', {
    getBankSlipRecord: async () => ({
      state: 'ready',
      bank: 'c6',
      bankSlipId: '01J3NCKY6Q99QC4D7T733D35QD'
    }),
    c6Config: () => ({ environment: 'sandbox' }),
    getC6BankSlipPdf: async () => c6Pdf
  });
  assert.equal(downloaded, c6Pdf);
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
