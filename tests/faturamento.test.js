const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const {
  validCredentials,
  createSessionToken,
  verifySessionToken,
  sessionCookie
} = require('../server/faturamento/auth');
const {
  buildInvoiceQuery,
  normalizeInvoice,
  normalizeVisibleInvoices,
  validCnpj,
  companyTradeNameFromPayload,
  companyLookupPath,
  enrichInvoicesWithCompanies,
  invoiceListFromPayload,
  collectAllInvoicePages,
  filterInvoicesById,
  filterAndSortCompanyInvoices,
  invoiceMatchesQuery,
  isPendingInvoice,
  buildDebtorSummary,
  plainInvoiceIdQuery
} = require('../server/faturamento/brudam');
const { MAX_ATTEMPTS } = require('../server/faturamento/rate-limit');
const { queryFromRequest } = require('../server/faturamento/http');
const { defaultDirectionFor, sortInvoices } = require('../faturamento/sort');

const withBillingEnv = (callback) => {
  const previous = {
    user: process.env.FATURAMENTO_ADMIN_USER,
    password: process.env.FATURAMENTO_ADMIN_PASSWORD,
    secret: process.env.FATURAMENTO_SESSION_SECRET
  };
  process.env.FATURAMENTO_ADMIN_USER = 'admin';
  process.env.FATURAMENTO_ADMIN_PASSWORD = 'senha-segura-de-teste';
  process.env.FATURAMENTO_SESSION_SECRET = 'segredo-de-sessao-com-mais-de-32-caracteres';
  try {
    callback();
  } finally {
    if (previous.user === undefined) delete process.env.FATURAMENTO_ADMIN_USER;
    else process.env.FATURAMENTO_ADMIN_USER = previous.user;
    if (previous.password === undefined) delete process.env.FATURAMENTO_ADMIN_PASSWORD;
    else process.env.FATURAMENTO_ADMIN_PASSWORD = previous.password;
    if (previous.secret === undefined) delete process.env.FATURAMENTO_SESSION_SECRET;
    else process.env.FATURAMENTO_SESSION_SECRET = previous.secret;
  }
};

test('valida credenciais sem expor a senha no cliente', () => {
  withBillingEnv(() => {
    assert.equal(validCredentials('admin', 'senha-segura-de-teste'), true);
    assert.equal(validCredentials('admin', 'senha-incorreta'), false);
    assert.equal(validCredentials('outro', 'senha-segura-de-teste'), false);
  });
});

test('permite até 15 tentativas de login por janela', () => {
  assert.equal(MAX_ATTEMPTS, 15);
});

test('cria sessão assinada, expira e configura cookie protegido', () => {
  withBillingEnv(() => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const token = createSessionToken('admin', now);
    assert.equal(verifySessionToken(token, now + 1000)?.sub, 'admin');
    assert.equal(verifySessionToken(`${token}alterado`, now + 1000), null);
    assert.equal(verifySessionToken(token, now + 9 * 60 * 60 * 1000), null);
    assert.match(sessionCookie(token, true), /HttpOnly/);
    assert.match(sessionCookie(token, true), /SameSite=Strict/);
    assert.match(sessionCookie(token, true), /Secure/);
  });
});

test('monta somente os filtros permitidos pela API de faturas', () => {
  const result = buildInvoiceQuery({
    'emissao[gte]': '2026-07-01',
    'emissao[lte]': '2026-07-31',
    status: '0',
    cnpj: '97.434.690/0001-29',
    id: '133',
    limit: '50',
    skip: '100',
    segredo: 'não-deve-passar'
  });
  const query = new URLSearchParams(result.query);
  assert.equal(query.get('emissao[gte]'), '2026-07-01');
  assert.equal(query.get('status'), '0');
  assert.equal(query.get('cnpj'), '97434690000129');
  assert.equal(query.get('id[eq]'), '133');
  assert.equal(query.get('id'), null);
  assert.equal(query.get('segredo'), null);
  assert.equal(result.limit, 50);
  assert.equal(result.skip, 0);
  assert.equal(result.exactCnpj, '97434690000129');
});

test('lê os filtros diretamente da URL recebida pela função', () => {
  assert.deepEqual(queryFromRequest({
    url: '/api/faturamento/faturas?id=11490&status=0&emissao%5Bgte%5D=2026-07-01&limit=100&skip=0',
    headers: {
      host: 'www.twt.com.br',
      'x-forwarded-proto': 'https'
    }
  }), {
    id: '11490',
    status: '0',
    'emissao[gte]': '2026-07-01',
    limit: '100',
    skip: '0'
  });
});

test('coleta os filtros do formulário antes de desabilitar os campos', () => {
  const source = readFileSync(require.resolve('../faturamento/app.js'), 'utf8');
  const loadInvoices = source.slice(
    source.indexOf('const loadInvoices = async'),
    source.indexOf("elements.loginForm.addEventListener")
  );
  assert.ok(loadInvoices.indexOf('const params = filterParams();') < loadInvoices.indexOf('setLoading(true);'));
  assert.match(loadInvoices, /faturas\?\$\{params\}/);
});

test('coluna Visualizar abre o PDF em nova guia e não oferece ordenação', () => {
  const html = readFileSync(require.resolve('../faturamento/index.html'), 'utf8');
  const source = readFileSync(require.resolve('../faturamento/app.js'), 'utf8');
  assert.match(html, /class="visualize-header">Visualizar<\/th>/);
  assert.doesNotMatch(html, /data-sort-key="paidAt"/);
  assert.match(source, /\/api\/faturamento\/fatura-pdf\?id=/);
  assert.match(source, /link\.target = '_blank'/);
  assert.match(source, /noopener noreferrer/);
});

test('rejeita data, status e CNPJ inválidos', () => {
  assert.throws(() => buildInvoiceQuery({ 'emissao[gte]': '2026-02-30' }), /Data inválida/);
  assert.throws(() => buildInvoiceQuery({ status: '9' }), /Status inválido/);
  assert.throws(() => buildInvoiceQuery({ cnpj: '123' }), /CNPJ inválido/);
});

test('normaliza os dados documentados e calcula saldo', () => {
  assert.deepEqual(normalizeInvoice({
    id: '133',
    valor: '583.62',
    emissao: '2016-11-11',
    vencimento: '2016-11-28',
    status: '1',
    cliente: {
      cnpj: '99999999999999',
      fantasia: 'TESTE'
    },
    situacao: 'Liquidado'
  }), {
    id: '133',
    internalId: '133',
    clientId: null,
    issuedAt: '2016-11-11',
    dueAt: '2016-11-28',
    paidAt: null,
    client: 'TESTE',
    clientDocument: '99999999999999',
    total: 583.62,
    paid: 583.62,
    balance: 0,
    status: 1,
    statusLabel: 'Liquidado'
  });
});

test('normaliza o número público da fatura no retorno real da Brudam', () => {
  const payload = {
    message: 'OK',
    status: 1,
    data: {
      status: 1,
      qtd_lancamentos: 1,
      documentos: [{
        id: 20822,
        id_cliente: 454,
        cnpj_cliente: '04004335000139',
        status: '1',
        status_descricao: 'LIQUIDADO',
        valor: '677.10',
        emissao: '2026-07-10',
        data_vencimento: '2026-07-24',
        fatura: 11490
      }]
    }
  };
  const invoices = invoiceListFromPayload(payload).map(normalizeInvoice);
  assert.deepEqual(filterInvoicesById(invoices, 11490), [{
    id: 11490,
    internalId: 20822,
    clientId: 454,
    issuedAt: '2026-07-10',
    dueAt: '2026-07-24',
    paidAt: null,
    client: '',
    clientDocument: '04004335000139',
    total: 677.1,
    paid: 677.1,
    balance: 0,
    status: 1,
    statusLabel: 'LIQUIDADO'
  }]);
});

test('remove lançamentos bancários sem número público de fatura', () => {
  const invoices = normalizeVisibleInvoices([
    {
      id: 31001,
      fatura: 0,
      cnpj_cliente: '60746948000112',
      valor: '0.02'
    },
    {
      id: 31002,
      fatura: null,
      cnpj_cliente: '60701190000104',
      valor: '0.47'
    },
    {
      id: 20822,
      fatura: 11490,
      cnpj_cliente: '04004335000139',
      valor: '677.10'
    },
    {
      id: 133,
      cliente: { cnpj: '99999999999999', fantasia: 'TESTE' },
      valor: '583.62'
    }
  ]);

  assert.deepEqual(invoices.map((invoice) => invoice.id), [11490, 133]);
});

test('valida CNPJ antes de consultar o cadastro de empresas', () => {
  assert.equal(validCnpj('06.404.676/0001-95'), false);
  assert.equal(validCnpj('28.759.933/0001-86'), true);
  assert.equal(validCnpj('06.908.675/0001-10'), true);
});

test('obtém o nome fantasia pelo CNPJ no retorno de empresas', () => {
  assert.equal(companyTradeNameFromPayload({
    message: 'OK',
    status: 1,
    data: [{
      cnpj: '11280282000144',
      fantasia: 'BHZ - TARGET CARGO',
      razao: 'TARGET TRANSPORTE DE CARGAS E ENCOMENDAS EXPRESSAS EIRELI',
      id: '306043'
    }]
  }, '11.280.282/0001-44'), 'BHZ - TARGET CARGO');
  assert.equal(companyTradeNameFromPayload({
    message: 'OK',
    status: 1,
    data: [{
      cnpj: '35820448008110',
      fantasia: 'EMPRESA DE TESTE',
      razao: 'EMPRESA DE TESTE LTDA'
    }]
  }, '35.820.448/0081-10'), 'EMPRESA DE TESTE');
  assert.equal(companyTradeNameFromPayload({
    status: 1,
    data: [{ cnpj: '04004335000139', fantasia: 'OUTRA EMPRESA' }]
  }, '35820448008110'), '');
  assert.equal(companyTradeNameFromPayload({
    status: 1,
    data: {
      empresas: [{
        cnpj: '35820448006339',
        fantasia: 'Não informado',
        razao: 'WHITE MARTINS GASES INDUSTRIAIS LTDA'
      }]
    }
  }, '35.820.448/0063-39'), 'WHITE MARTINS GASES INDUSTRIAIS LTDA');
  assert.equal(companyTradeNameFromPayload({
    status: 1,
    data: [{
      id: 712,
      fantasia: 'CLIENTE COM CNPJ INVÁLIDO'
    }]
  }, '06404676000195', 712), 'CLIENTE COM CNPJ INVÁLIDO');
});

test('monta a consulta de empresa com o CNPJ sem máscara', () => {
  assert.equal(
    companyLookupPath({ cnpj: '11.280.282/0001-44' }),
    '/cadastro/empresas?cnpj=11280282000144'
  );
  assert.equal(
    companyLookupPath({ cnpj: '30.455.661/0019-00' }),
    '/cadastro/empresas?cnpj=30455661001900'
  );
});

test('enriquece faturas por CNPJ sem repetir consultas', async () => {
  const calls = [];
  const invoices = await enrichInvoicesWithCompanies([
    { id: 1, client: '', clientDocument: '35820448008110', clientId: 444 },
    { id: 2, client: 'Não informado', clientDocument: '35.820.448/0081-10', clientId: 444 },
    { id: 3, client: 'JÁ INFORMADO', clientDocument: '04004335000139' }
  ], async (cnpj, clientId) => {
    calls.push({ cnpj, clientId });
    return 'NOME FANTASIA';
  });
  assert.deepEqual(calls, [{ cnpj: '35820448008110', clientId: 444 }]);
  assert.equal(invoices[0].client, 'NOME FANTASIA');
  assert.equal(invoices[1].client, 'NOME FANTASIA');
  assert.equal(invoices[2].client, 'JÁ INFORMADO');
});

test('usa o CNPJ como chave principal mesmo quando o id_cliente se repete', async () => {
  const calls = [];
  const invoices = await enrichInvoicesWithCompanies([
    { id: 1, client: '', clientDocument: '11280282000144', clientId: 306043 },
    { id: 2, client: '', clientDocument: '30455661001900', clientId: 306043 }
  ], async (cnpj) => {
    calls.push(cnpj);
    return cnpj === '11280282000144' ? 'BHZ - TARGET CARGO' : 'OUTRA EMPRESA';
  });
  assert.deepEqual(calls.sort(), ['11280282000144', '30455661001900']);
  assert.deepEqual(invoices.map((invoice) => invoice.client), [
    'BHZ - TARGET CARGO',
    'OUTRA EMPRESA'
  ]);
});

test('aceita fatura única ou lista no retorno da Brudam', () => {
  const invoice = { id: 11490, valor: 100 };
  assert.deepEqual(invoiceListFromPayload({
    status: 1,
    data: invoice
  }), [invoice]);
  assert.deepEqual(invoiceListFromPayload({
    status: 1,
    data: { faturas: [invoice] }
  }), [invoice]);
  assert.deepEqual(invoiceListFromPayload({
    status: 1,
    data: []
  }), []);
  assert.deepEqual(invoiceListFromPayload({
    status: 1,
    data: {
      dados: {
        resultados: [invoice],
        total: 1
      }
    }
  }), [invoice]);
});

test('preserva os CT-es quando documentos pertence à fatura documentada', () => {
  const linkedCtes = [
    { id: '66620', numero: '6135-2', tipo: 'CTE', valor: '9.60' },
    { id: '66658', numero: '0-', tipo: 'CTE', valor: '10.40' }
  ];
  const documentedInvoice = {
    id: '133',
    valor: '583.62',
    emissao: '2016-11-11',
    vencimento: '2016-11-28',
    qtd_doc: 2,
    status: '1',
    cliente: {
      cnpj: '99999999999999',
      fantasia: 'TESTE'
    },
    documentos: linkedCtes
  };

  const result = invoiceListFromPayload({
    message: 'OK',
    status: 1,
    data: documentedInvoice
  });

  assert.equal(result.length, 1);
  assert.equal(result[0], documentedInvoice);
  assert.deepEqual(result[0].documentos, linkedCtes);
});

test('mantém compatibilidade com o envelope real de lançamentos', () => {
  const invoiceRows = [
    { id: 20822, fatura: 11490, valor: '677.10' }
  ];
  assert.deepEqual(invoiceListFromPayload({
    status: 1,
    data: { status: 1, qtd_lancamentos: 1, documentos: invoiceRows }
  }), invoiceRows);
});

test('mantém somente a fatura com o ID solicitado', () => {
  const invoices = [
    { id: 11489, total: 10 },
    { id: 11490, total: 20 },
    { id: 11491, total: 30 }
  ];
  assert.deepEqual(filterInvoicesById(invoices, 11490), [
    { id: 11490, total: 20 }
  ]);
  assert.equal(filterInvoicesById(invoices, null).length, 3);
});

test('monta a consulta alternativa com o parâmetro id simples', () => {
  assert.equal(
    plainInvoiceIdQuery('id%5Beq%5D=11381&limit=100&skip=0', 11381),
    'limit=100&skip=0&id=11381'
  );
});

test('carrega todas as páginas de faturas de um CNPJ', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    fatura: index + 1
  }));
  const requestedQueries = [];
  const result = await collectAllInvoicePages(
    'cnpj=35820448008110&limit=100&skip=0',
    firstPage,
    async (query) => {
      requestedQueries.push(query);
      const skip = Number(new URLSearchParams(query).get('skip'));
      const documentos = skip === 100
        ? [{ id: 101, fatura: 101 }]
        : [];
      return {
        response: { ok: true },
        payload: { status: 1, data: { documentos } }
      };
    }
  );
  assert.equal(result.invoices.length, 101);
  assert.equal(result.pagesLoaded, 2);
  assert.equal(new URLSearchParams(requestedQueries[0]).get('skip'), '100');
});

test('filtra pelo CNPJ e ordena todas as faturas pela emissão decrescente', () => {
  const invoices = filterAndSortCompanyInvoices([
    { id: 1, issuedAt: '2023-09-06', clientDocument: '35820448008110' },
    { id: 3, issuedAt: '2026-06-19', clientDocument: '35820448008110' },
    { id: 2, issuedAt: '2025-01-10', clientDocument: '04004335000139' }
  ], '35.820.448/0081-10');
  assert.deepEqual(invoices.map((invoice) => invoice.id), [3, 1]);
});

test('ordena faturas pela emissão mais recente por padrão', () => {
  const invoices = [
    { id: 1, issuedAt: '2026-06-19' },
    { id: 2, issuedAt: '2026-07-10' },
    { id: 3, issuedAt: null }
  ];
  assert.deepEqual(sortInvoices(invoices).map((invoice) => invoice.id), [2, 1, 3]);
  assert.equal(defaultDirectionFor('issuedAt'), 'desc');
});

test('ordena números e textos nos dois sentidos', () => {
  const invoices = [
    { id: 1, total: 20, client: 'Zulu' },
    { id: 2, total: 5, client: 'Ágata' },
    { id: 3, total: 10, client: 'Brasil' }
  ];
  assert.deepEqual(sortInvoices(invoices, 'total', 'asc').map((invoice) => invoice.id), [2, 3, 1]);
  assert.deepEqual(sortInvoices(invoices, 'total', 'desc').map((invoice) => invoice.id), [1, 3, 2]);
  assert.deepEqual(sortInvoices(invoices, 'client', 'asc').map((invoice) => invoice.id), [2, 3, 1]);
});

test('aplica localmente os filtros usados no modo gráfico', () => {
  const invoice = {
    id: 11586,
    issuedAt: '2026-08-03',
    dueAt: '2026-08-14',
    clientDocument: '28759933000186',
    status: 0
  };
  assert.equal(invoiceMatchesQuery(
    invoice,
    'emissao%5Bgte%5D=2026-08-01&vencimento%5Blte%5D=2026-08-31&status=0'
  ), true);
  assert.equal(invoiceMatchesQuery(invoice, 'emissao%5Bgte%5D=2026-08-04'), false);
  assert.equal(invoiceMatchesQuery(invoice, 'cnpj=06908675000110'), false);
});

test('resume somente saldos pendentes por empresa', () => {
  const invoices = [
    {
      id: 1,
      client: 'EMPRESA A',
      clientDocument: '11111111000111',
      balance: 100,
      status: 0,
      statusLabel: 'PENDENTE'
    },
    {
      id: 2,
      client: 'EMPRESA A',
      clientDocument: '11111111000111',
      balance: 50.25,
      status: 0,
      statusLabel: 'EM ABERTO'
    },
    {
      id: 3,
      client: 'EMPRESA B',
      clientDocument: '22222222000122',
      balance: 49.75,
      status: null,
      statusLabel: 'PENDENTE'
    },
    {
      id: 4,
      client: 'EMPRESA C',
      clientDocument: '33333333000133',
      balance: 80,
      status: 1,
      statusLabel: 'LIQUIDADO'
    },
    {
      id: 5,
      client: 'EMPRESA D',
      clientDocument: '44444444000144',
      balance: 30,
      status: 2,
      statusLabel: 'CANCELADA'
    }
  ];
  assert.equal(isPendingInvoice(invoices[0]), true);
  assert.equal(isPendingInvoice(invoices[3]), false);

  const summary = buildDebtorSummary(invoices);
  assert.equal(summary.totalPending, 200);
  assert.equal(summary.invoiceCount, 3);
  assert.equal(summary.companyCount, 2);
  assert.equal(summary.debtors[0].name, 'EMPRESA A');
  assert.equal(summary.debtors[0].value, 150.25);
  assert.equal(summary.debtors[0].percentage, 75.125);
  assert.equal(summary.debtors[1].value, 49.75);
});

test('expõe o modo gráfico e envia a visualização de devedores à API', () => {
  const html = readFileSync(require.resolve('../faturamento/index.html'), 'utf8');
  const source = readFileSync(require.resolve('../faturamento/app.js'), 'utf8');
  assert.match(html, /data-view-mode="debtors"/);
  assert.match(html, /id="debtorChart"/);
  assert.match(html, /id="chartTooltipPercentage"/);
  assert.match(source, /params\.set\('view', 'debtors'\)/);
  assert.match(source, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'circle'\)/);
});
