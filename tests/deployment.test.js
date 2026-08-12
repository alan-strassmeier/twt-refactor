const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
