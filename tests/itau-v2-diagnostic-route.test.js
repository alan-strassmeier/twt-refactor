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
