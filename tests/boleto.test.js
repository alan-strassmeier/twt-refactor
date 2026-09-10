const test = require('node:test');
const assert = require('node:assert/strict');

const {
  externalReferenceForInvoice,
  payerFromCompany,
  resolveInvoiceBillingData,
  bradescoBankSlipPayload,
  itauOurNumberForInvoice,
  itauAmountForPayload,
  itauBankSlipPayload,
  itauBankSlipId,
  itauLookupError,
  generateInvoiceBankSlip,
  getInvoiceBankSlipPdf
} = require('../server/faturamento/boleto');
const {
  BILLING_BANKS,
  WHITE_MARTINS_TED_DOC_CNPJS,
  ELECNOR_TED_DOC_CNPJS,
  bankSlipBankForIssuer,
  requiresTedDocPayment
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
  bairro: 'CENTRO HISTORICO',
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

test('normaliza o pagador conforme dados obrigatórios das APIs bancárias', () => {
  const payer = payerFromCompany(payerCompany);
  assert.equal(payer.name.length, 40);
  assert.equal(payer.tax_id, '28759933000186');
  assert.equal(payer.address.number, '123');
  assert.equal(payer.address.zip_code, '91000000');
  assert.equal(payer.address.street.length <= 40, true);
  assert.equal(payer.email, 'financeiro@example.com');
});

test('gera referência externa determinística com no máximo dez caracteres', () => {
  assert.equal(externalReferenceForInvoice('11518'), 'TWT11518');
  const long = externalReferenceForInvoice('12345678901234567890');
  assert.match(long, /^TWT[A-F0-9]{7}$/);
  assert.equal(long.length, 10);
});

test('roteia TWT para Bradesco e DSL para Itaú usando o emitente confirmado no DOCCOB', async () => {
  const billing = await resolveInvoiceBillingData('11518', billingDependencies());
  assert.equal(billing.invoiceId, '11518');
  assert.equal(billing.issuerCnpj, '09123137000108');
  assert.equal(billing.bank, BILLING_BANKS.bradesco);
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

test('identifica clientes e forma de pagamento exclusivos de TED/DOC', () => {
  assert.equal(requiresTedDocPayment({
    clientNames: ['THE WHITE MARTINS GASES INDUSTRIAIS DO NORDESTE LTDA.']
  }), true);
  assert.equal(requiresTedDocPayment({
    clientNames: ['RS WHITE MARTINS GASES INDUSTRIAIS LTDA 0063']
  }), true);
  assert.equal(requiresTedDocPayment({ clientNames: ['ELECNOR DO BRASIL LTDA'] }), true);
  assert.equal(requiresTedDocPayment({ clientNames: ['BL INDUSTRIA OTICA LTDA POA'] }), true);
  assert.equal(requiresTedDocPayment({ clientDocument: '27.011.022/0001-03' }), true);
  for (const cnpj of [
    ...WHITE_MARTINS_TED_DOC_CNPJS,
    ...ELECNOR_TED_DOC_CNPJS
  ]) {
    assert.equal(requiresTedDocPayment({ clientDocument: cnpj }), true, cnpj);
  }
  assert.equal(requiresTedDocPayment({ clientDocument: '309286' }), false);
  assert.equal(requiresTedDocPayment({ clientDocument: '309311' }), false);
  assert.equal(requiresTedDocPayment({ paymentMethod: 'Transferência TED/DOC' }), true);
  assert.equal(requiresTedDocPayment({ clientNames: ['OUTRO CLIENTE LTDA'] }), false);
});

test('bloqueia geração de boleto para cliente com pagamento por TED/DOC', async () => {
  await assert.rejects(
    resolveInvoiceBillingData('11518', {
      ...billingDependencies('97434690000129'),
      fetchCompany: async () => ({
        ...payerCompany,
        fantasia: 'THE WHITE MARTINS GASES INDUSTRIAIS DO NORDESTE LTDA.'
      })
    }),
    (error) => error.statusCode === 422 && /TED\/DOC/.test(error.message)
  );
});

test('fatura DSL é validada no Itaú sem registrar título nem chamar o Bradesco', async () => {
  let bradescoCalls = 0;
  let itauCalls = 0;
  const result = await generateInvoiceBankSlip('11518', {
    ...billingDependencies('97434690000129'),
    getBankSlipRecord: async () => null,
    bradescoConfig: () => { bradescoCalls += 1; },
    createBradescoBankSlip: async () => { bradescoCalls += 1; },
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
  assert.equal(bradescoCalls, 0);
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

test('monta a emissão Bradesco convencional com Nosso Número gerado pelo banco', async () => {
  const billing = await resolveInvoiceBillingData('11518', billingDependencies());
  const payload = bradescoBankSlipPayload(billing, {
    beneficiaryRoot: '09123137',
    beneficiaryBranch: '0001',
    beneficiaryControl: '08',
    productId: '09',
    registrationNegotiation: '721800000000000074',
    species: '4',
    acceptance: '2',
    monthlyInterestPercent: 4.5,
    dailyInterestPercent: 0.15,
    penaltyPercent: 3,
    interestStartDays: '2',
    penaltyStartDays: '2'
  });
  assert.equal(payload.nuTitulo, '0');
  assert.equal(payload.nuCliente, 'FAT11518');
  assert.equal(payload.nuNegociacao, '721800000000000074');
  assert.equal(payload.dtEmissaoTitulo, '03.08.2026');
  assert.equal(payload.dtVencimentoTitulo, '14.08.2026');
  assert.equal(payload.vlNominalTitulo, '1844.00');
  assert.equal(payload.percentualJuros, '4.50');
  assert.equal(payload.percentualMulta, '3.00');
  assert.equal(payload.qtdeDiasJuros, '2');
  assert.equal(payload.qtdeDiasMulta, '2');
  assert.equal(payload.cdEspecieTitulo, '4');
  assert.equal(payload.cdIndCpfcnpjPagador, '2');
  assert.equal(payload.cepPagador, '91000');
  assert.equal(payload.complementoCepPagador, '000');
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
  assert.equal(
    itauBankSlipId({}, payload, { beneficiaryId: '060200166662', wallet: '109' }),
    '06020016666210900011518'
  );
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
        id: '',
        registered: true,
        amount: 1844,
        dueDate: '2026-08-14',
        wallet: '109',
        ourNumber: '00011518',
        yourNumber: 'FAT11518',
        digitableLine: '34191234567890123456789012345678901234567890123',
        barCode: '34191234567890123456789012345678901234567890'
      };
    },
    queryItauBankSlips: async () => []
  };
  const first = await generateInvoiceBankSlip('11518', dependencies);
  const second = await generateInvoiceBankSlip('11518', dependencies);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.bank, 'itau');
  assert.equal(record.beneficiaryId, '150000052061');
  assert.equal(record.bankSlipId, '15000005206110900011518');
  assert.equal(record.payer.tax_id, '28759933000186');
  assert.equal(itauCalls, 1);
});

test('permite pular temporariamente somente a consulta preventiva de uma fatura nova', async () => {
  let record = null;
  let queryCalls = 0;
  let createCalls = 0;
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
      skipPrecheck: true,
      beneficiaryId: '150000052061',
      beneficiaryName: 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA',
      beneficiaryTaxId: '97434690000129',
      wallet: '109',
      species: '01',
      acceptance: 'N'
    }),
    queryItauBankSlips: async () => {
      queryCalls += 1;
      throw new Error('A consulta preventiva não deveria ser executada');
    },
    createItauBankSlip: async () => {
      createCalls += 1;
      return {
        id: '',
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

  const result = await generateInvoiceBankSlip('11518', dependencies);
  assert.equal(result.status, 'ready');
  assert.equal(result.created, true);
  assert.equal(queryCalls, 0);
  assert.equal(createCalls, 1);
});

test('reconcilia uma efetivação Itaú em revisão sem repetir o POST', async () => {
  let record = {
    state: 'review',
    invoiceId: '11518',
    issuerCnpj: '97434690000129',
    bank: 'itau',
    startedAt: '2026-08-09T02:00:00.000Z'
  };
  let createCalls = 0;
  let queryCalls = 0;
  const dependencies = {
    ...billingDependencies('97434690000129'),
    getBankSlipRecord: async () => record,
    saveBankSlipRecord: async (_invoiceId, value) => { record = value; },
    itauBoletoConfig: () => ({
      stage: 'efetivacao',
      skipPrecheck: true,
      beneficiaryId: '150000052061',
      beneficiaryName: 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA',
      beneficiaryTaxId: '97434690000129',
      wallet: '109',
      species: '01',
      acceptance: 'N'
    }),
    createItauBankSlip: async () => {
      createCalls += 1;
      throw new Error('POST não deveria ser repetido');
    },
    queryItauBankSlips: async (criteria) => {
      queryCalls += 1;
      assert.equal(criteria.ourNumber, '00011518');
      assert.equal(criteria.inclusionDate, '2026-08-08');
      return [{
        id: '',
        amount: 1844,
        dueDate: '2026-08-14',
        wallet: '109',
        ourNumber: '00011518',
        yourNumber: 'FAT11518',
        digitableLine: '34191234567890123456789012345678901234567890123',
        barCode: '34191234567890123456789012345678901234567890'
      }];
    }
  };

  const result = await generateInvoiceBankSlip('11518', dependencies);
  assert.equal(result.status, 'ready');
  assert.equal(result.created, false);
  assert.equal(record.bankSlipId, '15000005206110900011518');
  assert.equal(queryCalls, 1);
  assert.equal(createCalls, 0);
});

test('expõe o status e a mensagem segura quando a consulta Itaú falha', () => {
  const error = itauLookupError(
    'Não foi possível conferir no Itaú a tentativa anterior de emissão',
    Object.assign(new Error('Acesso não autorizado para esta operação'), {
      statusCode: 502,
      upstreamStatus: 403,
      receivedResponse: true
    })
  );
  assert.equal(error.statusCode, 403);
  assert.equal(error.expose, true);
  assert.match(error.message, /HTTP 403/);
  assert.match(error.message, /Acesso não autorizado/);
});

test('reaproveita boleto Itaú já emitido pela Brudam sem executar o POST', async () => {
  let record = null;
  let createCalls = 0;
  let broadQueryCalls = 0;
  const dependencies = {
    ...billingDependencies('97434690000129'),
    now: new Date('2026-08-08T12:00:00Z'),
    getBankSlipRecord: async () => record,
    saveBankSlipRecord: async (_invoiceId, value) => { record = value; },
    claimBankSlip: async () => {
      throw new Error('Não deve criar lock quando o boleto já existe');
    },
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
      createCalls += 1;
      throw new Error('POST não deveria ser executado');
    },
    queryItauBankSlips: async (criteria) => {
      if (criteria.ourNumber) return [];
      broadQueryCalls += 1;
      if (criteria.inclusionDate !== '2026-08-03') return [];
      return [{
        id: 'boleto-criado-na-brudam',
        amount: 1844,
        dueDate: '2026-08-14',
        wallet: '109',
        ourNumber: '98765432',
        yourNumber: 'FAT11518',
        payerTaxId: '28759933000186',
        digitableLine: '34191234567890123456789012345678901234567890123',
        barCode: '34191234567890123456789012345678901234567890'
      }];
    }
  };

  const result = await generateInvoiceBankSlip('11518', dependencies);
  assert.equal(result.status, 'ready');
  assert.equal(result.created, false);
  assert.equal(record.bankSlipId, 'boleto-criado-na-brudam');
  assert.equal(record.ourNumber, '98765432');
  assert.equal(broadQueryCalls > 0, true);
  assert.equal(createCalls, 0);
});

test('PDFs do Itaú e Bradesco são gerados localmente com os dados registrados', async () => {
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

  const bradescoPdf = Buffer.from('%PDF-bradesco');
  const renderedBradesco = await getInvoiceBankSlipPdf('11518', {
    getBankSlipRecord: async () => ({
      state: 'ready',
      bank: 'bradesco',
      bankSlipId: '00000021311'
    }),
    renderBradescoBankSlipPdf: async () => bradescoPdf
  });
  assert.equal(renderedBradesco, bradescoPdf);
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
    bradescoConfig: () => ({
      beneficiaryRoot: '09123137',
      beneficiaryBranch: '0001',
      beneficiaryControl: '08',
      beneficiaryName: 'TWT AIRPACK SERVICOS AUX. DE TRANSP. AEREO LTDA',
      beneficiaryTaxId: '09123137000108',
      agency: '7218',
      agencyDigit: '4',
      account: '0000074',
      accountDigit: '4',
      productId: '09',
      registrationNegotiation: '721800000000000074',
      species: '4',
      acceptance: '2',
      monthlyInterestPercent: 4.5,
      dailyInterestPercent: 0.15,
      penaltyPercent: 3,
      interestStartDays: '2',
      penaltyStartDays: '2'
    }),
    createBradescoBankSlip: async (payload) => {
      createCalls += 1;
      assert.equal(payload.nuCliente, 'FAT11518');
      return {
        id: '00000021311',
        registered: true,
        ourNumber: '00000021311',
        yourNumber: 'FAT11518',
        wallet: '09',
        amount: 1844,
        dueDate: '2026-08-14',
        digitableLine: '23797218029000000213011000007408715790000072461',
        barCode: '23797157900000724617218090000002131100000740'
      };
    }
  };

  const first = await generateInvoiceBankSlip('11518', dependencies);
  const second = await generateInvoiceBankSlip('11518', dependencies);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.status, 'ready');
  assert.equal(first.bank, 'bradesco');
  assert.equal(record.ourNumber, '00000021311');
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
    bradescoConfig: () => ({
      beneficiaryRoot: '09123137',
      beneficiaryBranch: '0001',
      beneficiaryControl: '08',
      productId: '09',
      registrationNegotiation: '721800000000000074',
      species: '4',
      acceptance: '2',
      monthlyInterestPercent: 4.5,
      dailyInterestPercent: 0.15,
      penaltyPercent: 3,
      interestStartDays: '2',
      penaltyStartDays: '2'
    }),
    createBradescoBankSlip: async () => {
      throw Object.assign(new Error('timeout'), {
        statusCode: 504,
        ambiguousBankState: true
      });
    }
  };

  await assert.rejects(generateInvoiceBankSlip('11518', dependencies), /timeout/);
  assert.equal(record.state, 'review');
});
