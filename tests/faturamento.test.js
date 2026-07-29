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
  invoiceListFromPayload,
  filterInvoicesById
} = require('../server/faturamento/brudam');
const { MAX_ATTEMPTS } = require('../server/faturamento/rate-limit');
const { queryFromRequest } = require('../server/faturamento/http');

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
  assert.deepEqual(normalizeInvoice({
    id: 20822,
    id_cliente: 454,
    cnpj_cliente: '04004335000139',
    status: '1',
    status_descricao: 'LIQUIDADO',
    valor: '677.10',
    emissao: '2026-07-10',
    data_vencimento: '2026-07-24',
    fatura: 11490
  }), {
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
  });
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
