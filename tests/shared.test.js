const assert = require('node:assert/strict');
const test = require('node:test');
const {
  authorizedRequest,
  clearAccessToken
} = require('../server/shared/brudam');

const jwt = (expiresInSeconds) => {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds
  })).toString('base64url');
  return `header.${payload}.signature`;
};

test('cliente compartilhado da Brudam renova o token após resposta 401', async () => {
  const originalFetch = global.fetch;
  const originalUser = process.env.BRUDAM_API_USER;
  const originalPassword = process.env.BRUDAM_API_PASSWORD;
  process.env.BRUDAM_API_USER = 'a'.repeat(32);
  process.env.BRUDAM_API_PASSWORD = 'b'.repeat(64);
  clearAccessToken();

  const requests = [];
  let loginCount = 0;
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/acesso/auth/login')) {
      loginCount += 1;
      return new Response(JSON.stringify({
        status: 1,
        data: { access_key: jwt(600 + loginCount) }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (requests.filter((item) => item.url.endsWith('/tracking/teste')).length === 1) {
      return new Response(JSON.stringify({ status: 0 }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ status: 1, data: ['ok'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const { response, payload } = await authorizedRequest('/tracking/teste', {
      headers: { Accept: 'application/json' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(payload.data, ['ok']);
    assert.equal(loginCount, 2);
    const protectedRequests = requests.filter((item) => item.url.endsWith('/tracking/teste'));
    assert.equal(protectedRequests.length, 2);
    assert.match(protectedRequests[0].options.headers.Authorization, /^Bearer /);
    assert.notEqual(
      protectedRequests[0].options.headers.Authorization,
      protectedRequests[1].options.headers.Authorization
    );
  } finally {
    global.fetch = originalFetch;
    clearAccessToken();
    if (originalUser === undefined) delete process.env.BRUDAM_API_USER;
    else process.env.BRUDAM_API_USER = originalUser;
    if (originalPassword === undefined) delete process.env.BRUDAM_API_PASSWORD;
    else process.env.BRUDAM_API_PASSWORD = originalPassword;
  }
});
