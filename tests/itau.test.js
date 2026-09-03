const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOKEN_URL,
  API_BASE_URL,
  itauConfig,
  requestAccessToken,
  authenticatedRequest,
  resetTokenCache
} = require('../server/faturamento/itau');

const certificate = '-----BEGIN CERTIFICATE-----\nCERTIFICADO\n-----END CERTIFICATE-----\n';
const privateKey = '-----BEGIN PRIVATE KEY-----\nCHAVE\n-----END PRIVATE KEY-----\n';

const encoded = (value) => Buffer.from(value).toString('base64');

const configEnvironment = () => ({
  ITAU_CLIENT_ID: 'cliente-id',
  ITAU_CLIENT_SECRET: 'cliente-secret',
  ITAU_MTLS_CERT_BASE64: encoded(certificate),
  ITAU_MTLS_KEY_BASE64: encoded(privateKey)
});

test('configura os endpoints produtivos e os arquivos mTLS do Itaú', () => {
  const config = itauConfig(configEnvironment());
  assert.equal(config.tokenUrl, TOKEN_URL);
  assert.equal(config.apiBaseUrl, API_BASE_URL);
  assert.equal(config.apiKey, 'cliente-id');
  assert.equal(config.cert.toString(), certificate);
  assert.equal(config.key.toString(), privateKey);
});

test('recusa certificado ou chave que não contenham PEM válido', () => {
  assert.throws(
    () => itauConfig({
      ...configEnvironment(),
      ITAU_MTLS_CERT_BASE64: encoded('nao-e-certificado')
    }),
    /Certificado mTLS do Itaú inválido/
  );
  assert.throws(
    () => itauConfig({
      ...configEnvironment(),
      ITAU_MTLS_KEY_BASE64: encoded('nao-e-chave')
    }),
    /Chave privada mTLS do Itaú inválido/
  );
});

test('obtém access token do Itaú com client_credentials e mTLS', async () => {
  resetTokenCache();
  const config = itauConfig(configEnvironment());
  const result = await requestAccessToken(config, async (request) => {
    assert.equal(request.url, 'https://sts.itau.com.br/api/oauth/token');
    assert.equal(request.method, 'POST');
    assert.equal(request.config.cert.toString(), certificate);
    assert.equal(request.config.key.toString(), privateKey);
    const body = new URLSearchParams(request.body);
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('client_id'), 'cliente-id');
    assert.equal(body.get('client_secret'), 'cliente-secret');
    assert.match(request.headers['x-itau-correlationID'], /^[0-9a-f-]{36}$/);
    assert.match(request.headers['x-itau-flowID'], /^[0-9a-f-]{36}$/);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        access_token: 'token-produtivo',
        expires_in: 300,
        token_type: 'Bearer'
      }))
    };
  });

  assert.deepEqual(result, { token: 'token-produtivo', expiresIn: 300 });
});

test('envia token, api key e identificadores de rastreio nas chamadas Itaú', async () => {
  resetTokenCache();
  const config = itauConfig(configEnvironment());
  const requests = [];
  const request = async (options) => {
    requests.push(options);
    if (options.url === TOKEN_URL) {
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: 'token-produtivo', expires_in: 300 }))
      };
    }
    return { statusCode: 200, headers: {}, body: Buffer.from('{}') };
  };

  const response = await authenticatedRequest({
    path: '/cash_management/v2/exemplo',
    config,
    request
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://secure.gateway.api.itau/cash_management/v2/exemplo');
  assert.equal(requests[1].headers.Authorization, 'Bearer token-produtivo');
  assert.equal(requests[1].headers['x-itau-apikey'], 'cliente-id');
  assert.match(requests[1].headers['x-itau-correlationID'], /^[0-9a-f-]{36}$/);
  assert.match(requests[1].headers['x-itau-flowID'], /^[0-9a-f-]{36}$/);
});
