const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  SNAPSHOT_KEY,
  REFRESH_KEY,
  addInvoices,
  buildInactiveSnapshot,
  getInactiveSnapshot,
  startInactiveRefresh,
  continueInactiveRefresh
} = require('../server/faturamento/inactive-clients');

const invoice = (cnpj, issuedAt, id, name = 'Cliente Teste') => ({
  id: String(id), clientDocument: cnpj, issuedAt, client: name
});

const fakeRedis = () => {
  const values = new Map();
  const command = async (operation, ...args) => {
    if (operation === 'GET') return values.get(args[0]) || null;
    if (operation === 'SET') {
      const [key, value, ...options] = args;
      if (options.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }
    if (operation === 'EVAL') {
      const [script, count, ...rest] = args;
      const keys = rest.slice(0, Number(count));
      const parameters = rest.slice(Number(count));
      if (script.includes('cjson.decode(current).runId')) {
        const active = JSON.parse(values.get(keys[0]) || 'null');
        if (!active || active.runId !== parameters[0]) return 0;
        if (Number(count) === 2) {
          values.set(keys[1], parameters[1]);
          values.delete(keys[0]);
        } else {
          values.set(keys[0], parameters[1]);
        }
        return 1;
      }
      if (values.get(keys[0]) === parameters[0]) {
        values.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    throw new Error(`Comando Redis inesperado: ${operation}`);
  };
  return { command, values };
};

test('marca inativo no 31º dia e usa a emissão mais recente de qualquer status', () => {
  const run = { asOfDate: '2026-10-14', invoicesRead: 4, ignoredInvoices: 0, companies: {} };
  addInvoices(run, [
    invoice('11111111000111', '13/09/2026', 1, 'Empresa A'),
    invoice('11111111000111', '2026-08-01', 2, 'Nome Antigo'),
    invoice('22222222000122', '2026-09-14', 3, 'Empresa B'),
    invoice('33333333000133', '2026-10-01', 4, 'Empresa C')
  ]);
  const result = buildInactiveSnapshot(run, new Date('2026-10-14T12:00:00Z'));
  assert.equal(result.totalCompanies, 3);
  assert.deepEqual(result.clients.map((client) => client.cnpj), ['11111111000111']);
  assert.equal(result.clients[0].lastIssuedAt, '2026-09-13');
  assert.equal(result.clients[0].lastInvoiceId, '1');
  assert.equal(result.clients[0].daysSinceLastInvoice, 31);
});

test('ignora fatura sem CNPJ ou emissão confiável sem classificar empresa errada', () => {
  const run = { asOfDate: '2026-10-14', invoicesRead: 2, ignoredInvoices: 0, companies: {} };
  addInvoices(run, [invoice('', '2026-08-01', 1), invoice('11111111000111', '2026-02-30', 2)]);
  assert.equal(run.ignoredInvoices, 2);
  assert.equal(buildInactiveSnapshot(run).totalCompanies, 0);
});

test('troca o snapshot no Redis somente após percorrer todas as páginas', async () => {
  const { command } = fakeRedis();
  const previous = { updatedAt: '2026-09-01T00:00:00Z', clients: [{ cnpj: 'old' }] };
  await command('SET', SNAPSHOT_KEY, JSON.stringify(previous));
  const started = await startInactiveRefresh({ now: new Date('2026-10-14T12:00:00Z') }, command);
  const duplicateStart = await startInactiveRefresh({ now: new Date('2026-10-14T12:01:00Z') }, command);
  assert.equal(duplicateStart.runId, started.runId);

  const requests = [];
  const fetchPage = async (skip) => {
    requests.push(skip);
    if (skip < 200) return {
      invoices: Array.from({ length: 100 }, (_, index) =>
        invoice('11111111000111', '2026-08-01', skip + index + 1, 'Empresa A')),
      rawCount: 100,
      reportedTotal: 201,
      fingerprint: `page-${skip}`
    };
    return {
      invoices: [invoice('22222222000122', '2026-10-01', 201, 'Empresa B')],
      rawCount: 1,
      reportedTotal: 201,
      fingerprint: 'page-200'
    };
  };
  const options = {
    command, fetchPage, wait: async () => {}, now: () => new Date('2026-10-14T12:05:00Z')
  };
  const first = await continueInactiveRefresh({ runId: started.runId }, options);
  assert.equal(first.complete, false);
  assert.equal(first.refresh.invoicesRead, 200);
  assert.deepEqual(await getInactiveSnapshot(command), previous);

  const second = await continueInactiveRefresh({ runId: started.runId }, options);
  assert.equal(second.complete, true);
  assert.deepEqual(requests, [0, 100, 200]);
  assert.equal(second.snapshot.invoicesRead, 201);
  assert.equal(second.snapshot.totalCompanies, 2);
  assert.deepEqual(second.snapshot.clients.map((item) => item.cnpj), ['11111111000111']);
  assert.deepEqual(await getInactiveSnapshot(command), second.snapshot);
  assert.equal(await command('GET', REFRESH_KEY), null);
});

test('falha intermediária mantém a lista antiga e permite retomar do mesmo ponto', async () => {
  const { command } = fakeRedis();
  const previous = { clients: [{ cnpj: 'old' }] };
  await command('SET', SNAPSHOT_KEY, JSON.stringify(previous));
  const started = await startInactiveRefresh({ now: new Date('2026-10-14T12:00:00Z') }, command);
  let fail = true;
  const fetchPage = async (skip) => {
    if (skip === 100 && fail) throw Object.assign(new Error('Limite de requisições da Brudam'), { statusCode: 429 });
    return skip === 0
      ? { invoices: [invoice('11111111000111', '2026-08-01', 1)], rawCount: 100, reportedTotal: 101, fingerprint: 'first' }
      : { invoices: [invoice('22222222000122', '2026-08-02', 2)], rawCount: 1, reportedTotal: 101, fingerprint: 'second' };
  };
  const options = { command, fetchPage, wait: async () => {} };
  await assert.rejects(continueInactiveRefresh({ runId: started.runId }, options), /Limite de requisições/);
  assert.deepEqual(await getInactiveSnapshot(command), previous);
  assert.equal(JSON.parse(await command('GET', REFRESH_KEY)).skip, 0);
  fail = false;
  const result = await continueInactiveRefresh({ runId: started.runId }, options);
  assert.equal(result.complete, true);
  assert.equal(result.snapshot.totalCompanies, 2);
});

test('não apaga a lista quando a primeira página vazia não confirma total zero', async () => {
  const { command } = fakeRedis();
  const previous = { clients: [{ cnpj: 'old' }] };
  await command('SET', SNAPSHOT_KEY, JSON.stringify(previous));
  const started = await startInactiveRefresh({ now: new Date('2026-10-14T12:00:00Z') }, command);
  let attempts = 0;
  await assert.rejects(continueInactiveRefresh({ runId: started.runId }, {
    command,
    wait: async () => {},
    fetchPage: async () => {
      attempts += 1;
      return { invoices: [], rawCount: 0, reportedTotal: null, fingerprint: 'empty' };
    }
  }), /não confirmou que não há faturas/);
  assert.equal(attempts, 2);
  assert.deepEqual(await getInactiveSnapshot(command), previous);
});

test('página repetida impede a publicação de uma lista incompleta', async () => {
  const { command } = fakeRedis();
  const previous = { clients: [{ cnpj: 'old' }] };
  await command('SET', SNAPSHOT_KEY, JSON.stringify(previous));
  const started = await startInactiveRefresh({ now: new Date('2026-10-14T12:00:00Z') }, command);
  const full = {
    invoices: [invoice('11111111000111', '2026-08-01', 1)],
    rawCount: 100,
    reportedTotal: 200,
    fingerprint: 'same-page'
  };
  await assert.rejects(continueInactiveRefresh({ runId: started.runId }, {
    command, wait: async () => {}, fetchPage: async () => full
  }), /repetiu a mesma página/);
  assert.deepEqual(await getInactiveSnapshot(command), previous);
});

test('interface abre uma terceira área e não consulta a Brudam ao entrar nela', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'faturamento', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'faturamento', 'clientes-inativos.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api', 'faturamento', 'cobranca.js'), 'utf8');
  assert.match(html, /data-billing-area="inactive"/);
  assert.match(html, /id="inactiveWorkspace"/);
  assert.match(html, /id="refreshInactiveClients"/);
  assert.match(script, /elements\.tab\.addEventListener\('click', loadCached\)/);
  assert.match(script, /request\(\{ action: 'start' \}\)/);
  assert.match(api, /query\.route === 'inactive-clients'/);
});

test('entrar novamente na aba reutiliza a lista carregada sem nova requisição', async () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'faturamento', 'clientes-inativos.js'), 'utf8');
  const handlers = {};
  const element = () => ({ textContent: '', dataset: {}, hidden: false, disabled: false });
  const tab = { addEventListener: (type, handler) => { handlers[`tab:${type}`] = handler; } };
  const refresh = { ...element(), addEventListener: (type, handler) => {
    handlers[`refresh:${type}`] = handler;
  } };
  const empty = { ...element(), querySelector: () => element() };
  const rows = { replaceChildren: () => {}, appendChild: () => {} };
  const ids = {
    inactiveWorkspace: element(), refreshInactiveClients: refresh,
    inactiveClientsMessage: element(), inactiveClientsCount: element(),
    inactiveCompaniesCount: element(), inactiveUpdatedAt: element(),
    inactiveClientsRows: rows, inactiveClientsEmpty: empty
  };
  const requests = [];
  const fetch = async (_url, options) => {
    requests.push(options.method);
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ snapshot: null, refresh: null })
    };
  };
  vm.runInNewContext(script, {
    document: {
      querySelector: () => tab,
      getElementById: (id) => ids[id] || null,
      createDocumentFragment: () => ({ appendChild: () => {} })
    },
    fetch, Intl, Date, Promise, setTimeout
  });
  await handlers['tab:click']();
  await handlers['tab:click']();
  assert.deepEqual(requests, ['GET']);
});
