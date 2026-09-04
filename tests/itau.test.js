const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOKEN_URL,
  API_BASE_URL,
  itauConfig,
  itauBoletoConfig,
  requestAccessToken,
  authenticatedRequest,
  itauAmount,
  normalizeItauBankSlip,
  createItauBankSlip,
  queryItauBankSlips,
  resetTokenCache
} = require('../server/faturamento/itau');

const certificate = '-----BEGIN CERTIFICATE-----\nCERTIFICADO\n-----END CERTIFICATE-----\n';
const privateKey = '-----BEGIN PRIVATE KEY-----\nCHAVE\n-----END PRIVATE KEY-----\n';

const encoded = (value) => Buffer.from(value).toString('base64');

const configEnvironment = () => ({
  ITAU_CLIENT_ID: 'cliente-id',
  ITAU_CLIENT_SECRET: 'cliente-secret',
  ITAU_MTLS_CERT_BASE64: encoded(certificate),
  ITAU_MTLS_KEY_BASE64: encoded(privateKey),
  ITAU_BENEFICIARY_ID: '150000052061',
  ITAU_BOLETO_WALLET: '109'
});

test('configura os endpoints produtivos e os arquivos mTLS do Itaú', () => {
  const config = itauConfig(configEnvironment());
  assert.equal(config.tokenUrl, TOKEN_URL);
  assert.equal(config.apiBaseUrl, API_BASE_URL);
  assert.equal(config.apiKey, 'cliente-id');
  assert.equal(config.cert.toString(), certificate);
  assert.equal(config.key.toString(), privateKey);
});

test('mantém emissão Itaú em validação até a ativação explícita', () => {
  const validation = itauBoletoConfig(configEnvironment());
  const production = itauBoletoConfig({
    ...configEnvironment(),
    ITAU_BOLETO_STAGE: 'efetivacao'
  });
  assert.equal(validation.stage, 'validacao');
  assert.equal(validation.beneficiaryId, '150000052061');
  assert.equal(validation.wallet, '109');
  assert.equal(production.stage, 'efetivacao');
  assert.throws(
    () => itauBoletoConfig({ ...configEnvironment(), ITAU_BENEFICIARY_ID: '123' }),
    /totalizando 12 dígitos/
  );
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
    path: 'exemplo',
    config,
    request
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://api.gateway.itau.com.br/cash_management/v2/exemplo');
  assert.equal(requests[1].headers.Authorization, 'Bearer token-produtivo');
  assert.equal(requests[1].headers['x-itau-apikey'], 'cliente-id');
  assert.match(requests[1].headers['x-itau-correlationID'], /^[0-9a-f-]{36}$/);
  assert.match(requests[1].headers['x-itau-flowID'], /^[0-9a-f-]{36}$/);
});

test('normaliza a resposta oficial de emissão, inclusive valores sem separador decimal', () => {
  const bankSlip = normalizeItauBankSlip({
    data: {
      id_boleto: 'b1ff5cc0-8a9c-497e-b983-738904c23386',
      etapa_processo_boleto: 'efetivacao',
      beneficiario: { id_beneficiario: '150000052061' },
      dado_boleto: {
        codigo_carteira: '109',
        dados_individuais_boleto: [{
          numero_nosso_numero: '00011532',
          texto_seu_numero: 'FAT11532',
          data_vencimento: '2026-09-20',
          valor_titulo: '00000000000119900',
          numero_linha_digitavel: '34191234567890123456789012345678901234567890123',
          codigo_barras: '34191234567890123456789012345678901234567890'
        }]
      }
    }
  });
  assert.equal(bankSlip.registered, true);
  assert.equal(bankSlip.amount, 1199);
  assert.equal(bankSlip.ourNumber, '00011532');
  assert.equal(itauAmount('180.00'), 180);
});

test('emite boleto pelo endpoint oficial usando OAuth2 e mTLS', async () => {
  resetTokenCache();
  const config = itauBoletoConfig({
    ...configEnvironment(),
    ITAU_BOLETO_STAGE: 'efetivacao'
  });
  const requests = [];
  const request = async (options) => {
    requests.push(options);
    if (options.url === TOKEN_URL) {
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: 'token-itau', expires_in: 300 }))
      };
    }
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({
        data: {
          id_boleto: 'boleto-id',
          etapa_processo_boleto: 'efetivacao',
          beneficiario: { id_beneficiario: '150000052061' },
          dado_boleto: {
            codigo_carteira: '109',
            dados_individuais_boleto: [{
              numero_nosso_numero: '00011532',
              data_vencimento: '2026-09-20',
              valor_titulo: '501.87',
              numero_linha_digitavel: '34191234567890123456789012345678901234567890123',
              codigo_barras: '34191234567890123456789012345678901234567890'
            }]
          }
        }
      }))
    };
  };
  const result = await createItauBankSlip({
    etapa_processo_boleto: 'efetivacao',
    beneficiario: { id_beneficiario: '150000052061' },
    dado_boleto: { dados_individuais_boleto: [{ valor_titulo: '501.87' }] }
  }, { config, request });

  assert.equal(requests[1].url, 'https://api.gateway.itau.com.br/cash_management/v2/boletos');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].headers.Authorization, 'Bearer token-itau');
  assert.equal(result.id, 'boleto-id');
  assert.equal(result.registered, true);
  assert.equal(result.amount, 501.87);
});

test('propaga de forma segura o erro de validação devolvido pelo Itaú', async () => {
  resetTokenCache();
  const config = itauBoletoConfig(configEnvironment());
  const request = async (options) => {
    if (options.url === TOKEN_URL) {
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: 'token-itau', expires_in: 300 }))
      };
    }
    return {
      statusCode: 422,
      headers: {},
      body: Buffer.from(JSON.stringify({
        erros: [{ mensagem: 'Código do beneficiário inválido.' }]
      }))
    };
  };
  await assert.rejects(
    createItauBankSlip({ etapa_processo_boleto: 'validacao' }, { config, request }),
    (error) => error.statusCode === 422 &&
      error.expose === true &&
      error.message === 'Código do beneficiário inválido.'
  );
});

test('distingue falha de autenticação de estado bancário incerto após o POST', async () => {
  const config = itauBoletoConfig({
    ...configEnvironment(),
    ITAU_BOLETO_STAGE: 'efetivacao'
  });
  resetTokenCache();
  await assert.rejects(
    createItauBankSlip({}, {
      config,
      request: async () => { throw new Error('STS indisponível'); }
    }),
    (error) => error.ambiguousBankState !== true
  );

  resetTokenCache();
  await assert.rejects(
    createItauBankSlip({}, {
      config,
      request: async (options) => {
        if (options.url === TOKEN_URL) {
          return {
            statusCode: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({ access_token: 'token-itau', expires_in: 300 }))
          };
        }
        throw new Error('Conexão caiu depois do envio');
      }
    }),
    (error) => error.ambiguousBankState === true
  );
});

test('consulta boletos pelos parâmetros documentados pelo Itaú', async () => {
  resetTokenCache();
  const config = itauBoletoConfig(configEnvironment());
  const requests = [];
  const request = async (options) => {
    requests.push(options);
    if (options.url === TOKEN_URL) {
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: 'token-itau', expires_in: 300 }))
      };
    }
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ value: { data: [{
        id_boleto: 'boleto-id',
        dado_boleto: { dados_individuais_boleto: [{ numero_nosso_numero: '00011532' }] }
      }] } }))
    };
  };
  const list = await queryItauBankSlips({
    wallet: '109',
    ourNumber: '00011532',
    inclusionDate: '2026-09-04',
    view: 'specific'
  }, { config, request });
  const url = new URL(requests[1].url);
  assert.equal(url.searchParams.get('id_beneficiario'), '150000052061');
  assert.equal(url.searchParams.get('codigo_carteira'), '109');
  assert.equal(url.searchParams.get('nosso_numero'), '00011532');
  assert.equal(url.searchParams.get('data_inclusao'), '2026-09-04');
  assert.equal(url.searchParams.get('view'), 'specific');
  assert.equal(list[0].ourNumber, '00011532');
});
