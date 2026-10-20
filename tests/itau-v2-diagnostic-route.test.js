const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/faturamento/cobranca');

test('diagnóstico Itaú v2 recusa sessão ausente antes de consultar o banco', async () => {
  const headers = {};
  const response = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; }
  };
  await handler({
    method: 'GET',
    url: '/api/faturamento/cobranca?route=itau-v2-diagnostic',
    headers: { host: 'example.test' }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).message,
    'Faça login para acessar a cobrança de faturas.');
  assert.equal(headers['cache-control'], 'no-store, max-age=0');
});

test('GET temporário do JSON bruto Itaú recusa sessão ausente', async () => {
  const response = {
    setHeader() {},
    end(body) { this.body = body; }
  };
  await handler({
    method: 'GET',
    url: '/api/faturamento/cobranca?route=itau-raw-11840&id=11840',
    headers: { host: 'example.test' }
  }, response);
  assert.equal(response.statusCode, 401);
});

test('prévia de baixa Itaú exige sessão antes de consultar banco ou Brudam', async () => {
  const response = {
    setHeader() {},
    end(body) { this.body = body; }
  };
  await handler({
    method: 'GET',
    url: '/api/faturamento/cobranca?route=itau-reconciliation-preview&id=11838',
    headers: { host: 'example.test' }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).message,
    'Faça login para acessar a cobrança de faturas.');
});

test('baixa direcionada Itaú exige sessão antes de qualquer operação', async () => {
  const response = {
    setHeader() {},
    end(body) { this.body = body; }
  };
  await handler({
    method: 'POST',
    url: '/api/faturamento/cobranca?route=itau-reconciliation-run',
    headers: { host: 'example.test' }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).message,
    'Faça login para acessar a cobrança de faturas.');
});
