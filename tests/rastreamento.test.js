const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const trackingApi = require('../api/rastreamento');
const { clearAccessToken } = require('../server/shared/brudam');

const invoke = async (body) => {
  const req = Readable.from([]);
  req.method = 'POST';
  req.body = body;
  req.headers = {
    host: 'www.twt.com.br',
    'x-forwarded-for': '198.51.100.20'
  };
  req.socket = { remoteAddress: '198.51.100.20' };

  const headers = {};
  let responseBody = '';
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(value = '') {
      responseBody += value;
    }
  };
  await trackingApi(req, res);
  return { statusCode: res.statusCode, headers, body: JSON.parse(responseBody) };
};

test('rastreamento reutiliza a autenticação compartilhada da Brudam', async () => {
  const originalFetch = global.fetch;
  process.env.BRUDAM_API_USER = 'a'.repeat(32);
  process.env.BRUDAM_API_PASSWORD = 'b'.repeat(64);
  clearAccessToken();
  const requests = [];

  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/acesso/auth/login')) {
      const tokenPayload = Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 600
      })).toString('base64url');
      return new Response(JSON.stringify({
        status: 1,
        data: { access_key: `header.${tokenPayload}.signature` }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: 1, data: [{ codigo: 1 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await invoke({
      type: 'nf',
      taxpayer: '97.434.690/0001-29',
      number: '12345'
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 1);
    assert.equal(requests.length, 2);
    assert.match(
      requests[1].url,
      /\/tracking\/ocorrencias\/cnpj\/nf\?documento=97434690000129&numero=12345$/
    );
    assert.match(requests[1].options.headers.Authorization, /^Bearer /);
  } finally {
    global.fetch = originalFetch;
    clearAccessToken();
  }
});
