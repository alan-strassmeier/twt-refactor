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
  companyTradeNameFromPayload,
  enrichInvoicesWithCompanies,
  invoiceListFromPayload,
  collectAllInvoicePages,
  filterInvoicesById,
  filterAndSortCompanyInvoices,
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

test('obtém o nome fantasia pelo CNPJ no retorno de empresas', () => {
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
});

test('enriquece faturas por CNPJ sem repetir consultas', async () => {
  const calls = [];
  const invoices = await enrichInvoicesWithCompanies([
    { id: 1, client: '', clientDocument: '35820448008110' },
    { id: 2, client: 'Não informado', clientDocument: '35.820.448/0081-10' },
    { id: 3, client: 'JÁ INFORMADO', clientDocument: '04004335000139' }
  ], async (cnpj) => {
    calls.push(cnpj);
    return 'NOME FANTASIA';
  });
  assert.deepEqual(calls, ['35820448008110']);
  assert.equal(invoices[0].client, 'NOME FANTASIA');
  assert.equal(invoices[1].client, 'NOME FANTASIA');
  assert.equal(invoices[2].client, 'JÁ INFORMADO');
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
