const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const apiRoot = path.join(root, 'api');

const listFunctionFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFunctionFiles(fullPath);
    return /\.(?:js|mjs|ts)$/.test(entry.name) ? [fullPath] : [];
  });

test('mantém o deployment dentro do limite de 12 funções do plano Hobby', () => {
  const functions = listFunctionFiles(apiRoot);
  assert.ok(functions.length <= 12, `Foram encontradas ${functions.length} funções em api/.`);
});

test('preserva as URLs públicas das rotas consolidadas', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const rewrites = new Map(config.rewrites.map(({ source, destination }) => [source, destination]));
  assert.equal(rewrites.get('/api/faturamento/login'), '/api/faturamento/auth?route=login');
  assert.equal(rewrites.get('/api/faturamento/logout'), '/api/faturamento/auth?route=logout');
  assert.equal(rewrites.get('/api/faturamento/session'), '/api/faturamento/auth?route=session');
  assert.equal(rewrites.get('/api/faturamento/nfse-agent'), '/api/faturamento/nfse?route=agent');
  assert.equal(rewrites.get('/api/faturamento/nfse-pdf'), '/api/faturamento/nfse?route=pdf');
  assert.equal(rewrites.get('/api/faturamento/nfse-xml'), '/api/faturamento/nfse?route=xml');
});

test('agenda a cobrança de hora em hora nos dias úteis de São Paulo', async () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(root, 'cloudflare', 'billing-cron', 'wrangler.jsonc'),
    'utf8'
  ));
  assert.deepEqual(config.triggers.crons, [
    '0 3-23 * * mon-fri',
    '0 0-2 * * tue-sat'
  ]);
  assert.equal(
    config.vars.BILLING_ENDPOINT,
    'https://www.twt.com.br/api/faturamento/cobranca?route=process'
  );
  const worker = await import(pathToFileURL(
    path.join(root, 'cloudflare', 'billing-cron', 'worker.js')
  ).href);
  assert.equal(worker.isSaoPauloWeekday(new Date('2026-10-17T15:00:00Z')), false);
  assert.equal(worker.isSaoPauloWeekday(new Date('2026-10-19T02:00:00Z')), false);
  assert.equal(worker.isSaoPauloWeekday(new Date('2026-10-19T03:00:00Z')), true);
  assert.equal(worker.isSaoPauloWeekday(new Date('2026-10-24T02:00:00Z')), true);
  assert.equal(worker.isSaoPauloWeekday(new Date('2026-10-24T03:00:00Z')), false);
  let triggered = false;
  await worker.default.scheduled({ scheduledTime: Date.parse('2026-10-17T15:00:00Z') }, {}, {
    waitUntil: () => { triggered = true; }
  });
  assert.equal(triggered, false);
});

test('Worker confere todos os lotes bancários antes de iniciar cobrança', async () => {
  const worker = await import(pathToFileURL(
    path.join(root, 'cloudflare', 'billing-cron', 'worker.js')
  ).href);
  const routes = [];
  const result = await worker.triggerBillingCollection({
    BILLING_ENDPOINT: 'https://www.twt.com.br/api/faturamento/cobranca?route=process',
    BILLING_CRON_SECRET: 'a'.repeat(32)
  }, async (url, options) => {
    const params = new URL(url).searchParams;
    routes.push(`${params.get('route')}:${params.get('bankReconciled') || ''}`);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${'a'.repeat(32)}`);
    if (params.get('route') === 'bank-reconciliation-cron') {
      return Response.json(routes.length === 1
        ? { checked: 25, settled: 2, alreadySettled: 1, pending: 22,
          errors: [], hasMore: true, nextCursor: '11838' }
        : { checked: 4, settled: 1, alreadySettled: 0, pending: 3,
          errors: [], hasMore: false, nextCursor: '11901' });
    }
    assert.equal(params.get('bankChecked'), '29');
    assert.equal(params.get('bankSettled'), '3');
    assert.equal(params.get('bankAlreadySettled'), '1');
    assert.equal(params.get('bankPending'), '25');
    return Response.json({ sent: 1 });
  });
  assert.deepEqual(routes, [
    'bank-reconciliation-cron:', 'bank-reconciliation-cron:', 'process:1'
  ]);
  assert.equal(result.sent, 1);
});

test('Worker não envia cobrança se um lote bancário falhar ou ficar incompleto', async () => {
  const worker = await import(pathToFileURL(
    path.join(root, 'cloudflare', 'billing-cron', 'worker.js')
  ).href);
  for (const bankResult of [
    { checked: 1, settled: 0, alreadySettled: 0, pending: 0,
      errors: [{ invoiceId: '11838' }], hasMore: true, nextCursor: '11838' },
    { checked: 0, settled: 0, alreadySettled: 0, pending: 0,
      errors: [], hasMore: true, nextCursor: '' }
  ]) {
    const routes = [];
    await assert.rejects(worker.triggerBillingCollection({
      BILLING_ENDPOINT: 'https://www.twt.com.br/api/faturamento/cobranca?route=process',
      BILLING_CRON_SECRET: 'b'.repeat(32)
    }, async (url) => {
      routes.push(new URL(url).searchParams.get('route'));
      return Response.json(bankResult);
    }), /cobrança não iniciada/);
    assert.deepEqual(routes, ['bank-reconciliation-cron']);
  }
});

test('Worker adia a cobrança após vinte lotes e preserva continuação no servidor', async () => {
  const worker = await import(pathToFileURL(
    path.join(root, 'cloudflare', 'billing-cron', 'worker.js')
  ).href);
  let calls = 0;
  await assert.rejects(worker.triggerBillingCollection({
    BILLING_ENDPOINT: 'https://www.twt.com.br/api/faturamento/cobranca?route=process',
    BILLING_CRON_SECRET: 'c'.repeat(32)
  }, async (url) => {
    assert.equal(new URL(url).searchParams.get('route'), 'bank-reconciliation-cron');
    calls += 1;
    return Response.json({ checked: 25, settled: 0, alreadySettled: 0,
      pending: 25, errors: [], hasMore: true, nextCursor: String(calls) });
  }), /próxima execução/);
  assert.equal(calls, 20);
});
