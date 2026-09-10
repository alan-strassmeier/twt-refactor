const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENVIRONMENTS,
  bradescoConfig,
  bradescoHttpError,
  requestAccessToken,
  authenticatedRequest,
  barCodeFromDigitableLine,
  normalizeBradescoBankSlip,
  createBradescoBankSlip,
  queryBradescoBankSlip,
  resetTokenCache
} = require('../server/faturamento/bradesco');

const pem = (type, content) => Buffer.from(
  `-----BEGIN ${type}-----\n${content}\n-----END ${type}-----\n`
).toString('base64');

const configEnvironment = (overrides = {}) => ({
  BRADESCO_ENVIRONMENT: 'sandbox',
  BRADESCO_CLIENT_ID: 'cliente-id',
  BRADESCO_CLIENT_SECRET: 'cliente-secreto',
  BRADESCO_MTLS_CERT_BASE64: pem('CERTIFICATE', 'CERTIFICADO'),
  BRADESCO_MTLS_KEY_BASE64: pem('PRIVATE KEY', 'CHAVE'),
  BRADESCO_BENEFICIARY_CNPJ: '09123137000108',
  BRADESCO_AGENCY: '7218',
  BRADESCO_AGENCY_DIGIT: '4',
  BRADESCO_ACCOUNT: '0000074',
  BRADESCO_ACCOUNT_DIGIT: '4',
  ...overrides
});

test('configura endpoints, negociação e encargos Bradesco por ambiente', () => {
  const sandbox = bradescoConfig(configEnvironment());
  const production = bradescoConfig(configEnvironment({ BRADESCO_ENVIRONMENT: 'production' }));

  assert.equal(sandbox.tokenUrl, ENVIRONMENTS.sandbox.tokenUrl);
  assert.equal(sandbox.registrationUrl, ENVIRONMENTS.sandbox.registrationUrl);
  assert.equal(production.queryUrl, ENVIRONMENTS.production.queryUrl);
  assert.equal(sandbox.beneficiaryRoot, '09123137');
  assert.equal(sandbox.beneficiaryBranch, '0001');
  assert.equal(sandbox.beneficiaryControl, '08');
  assert.equal(sandbox.registrationNegotiation, '721800000000000074');
  assert.equal(sandbox.queryNegotiation, '72180000074');
  assert.equal(sandbox.productId, '09');
  assert.equal(sandbox.species, '4');
  assert.equal(sandbox.penaltyPercent, 3);
  assert.equal(sandbox.dailyInterestPercent, 0.15);
  assert.equal(sandbox.monthlyInterestPercent, 4.5);
  assert.equal(sandbox.interestStartDays, '2');
  assert.equal(sandbox.penaltyStartDays, '2');
});

test('exige os dados bancários e arquivos PEM válidos', () => {
  assert.throws(
    () => bradescoConfig(configEnvironment({ BRADESCO_AGENCY: '' })),
    /BRADESCO_AGENCY/
  );
  assert.throws(
    () => bradescoConfig(configEnvironment({
      BRADESCO_MTLS_CERT_BASE64: Buffer.from('nao-pem').toString('base64')
    })),
    /Certificado mTLS do Bradesco inválido/
  );

  const encryptedKeyConfig = bradescoConfig(configEnvironment({
    BRADESCO_MTLS_KEY_BASE64: pem('ENCRYPTED PRIVATE KEY', 'CHAVE-CRIPTOGRAFADA'),
    BRADESCO_MTLS_KEY_PASSPHRASE: 'senha-da-chave'
  }));
  assert.match(encryptedKeyConfig.key.toString(), /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.equal(encryptedKeyConfig.passphrase, 'senha-da-chave');
});

test('expõe os campos rejeitados nas respostas de validação do Bradesco', () => {
  const error = bradescoHttpError({ statusCode: 400 }, {
    mensagem: 'Nao foi possivel processar as instrucoes contidas na requisicao',
    errosValidacao: {
      campo: 'Agencia',
      tipoRestricao: 'EXACT_LENGTH',
      mensagem: 'Numero de caracteres exatos nao atendidos'
    }
  }, 'O Bradesco recusou a emissão do boleto.');

  assert.equal(error.statusCode, 422);
  assert.equal(error.upstreamStatus, 400);
  assert.match(error.message, /Agencia: Numero de caracteres exatos nao atendidos/);
});

test('obtém token Bradesco com client_credentials e mTLS', async () => {
  resetTokenCache();
  const config = bradescoConfig(configEnvironment());
  const result = await requestAccessToken(config, async (request) => {
    assert.equal(request.url, ENVIRONMENTS.sandbox.tokenUrl);
    assert.equal(request.method, 'POST');
    assert.match(request.config.cert.toString(), /BEGIN CERTIFICATE/);
    const body = new URLSearchParams(request.body);
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('client_id'), 'cliente-id');
    assert.equal(body.get('client_secret'), 'cliente-secreto');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ access_token: 'token-seguro', expires_in: 3600 }))
    };
  });

  assert.deepEqual(result, { token: 'token-seguro', expiresIn: 3600 });
});

test('renova o token uma vez quando o Bradesco responde 401', async () => {
  resetTokenCache();
  const config = bradescoConfig(configEnvironment());
  let tokenCalls = 0;
  let apiCalls = 0;
  const request = async (options) => {
    if (options.url === config.tokenUrl) {
      tokenCalls += 1;
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 3600 }))
      };
    }
    apiCalls += 1;
    assert.equal(options.headers.Authorization, `Bearer token-${apiCalls}`);
    return {
      statusCode: apiCalls === 1 ? 401 : 200,
      headers: {},
      body: Buffer.from('{}')
    };
  };

  const result = await authenticatedRequest({
    url: config.queryUrl,
    body: '{}',
    config,
    request
  });
  assert.equal(result.statusCode, 200);
  assert.equal(tokenCalls, 2);
  assert.equal(apiCalls, 2);
});

test('reconstrói o código de barras numérico pela linha digitável', () => {
  const line = '23797.21802 90000.002130 11000.007408 7 15790000072461';
  assert.equal(
    barCodeFromDigitableLine(line),
    '23797157900000724617218090000002131100000740'
  );
});

test('normaliza a resposta de registro preservando Nosso Número com zeros', () => {
  const config = bradescoConfig(configEnvironment());
  const boleto = normalizeBradescoBankSlip({
    nuTituloGerado: 21311,
    idProduto: 9,
    linhaDigitavel: '23797.21802 90000.002130 11000.007408 7 15790000072461',
    vlTitulo: 72461,
    quantidadeCasas: 2,
    dtVencimentoBoleto: '24/09/2026',
    seuNumeroTitulo: 'FAT11777',
    nomeBeneficiario: 'TWT AIRPACK SERVICOS AUX DE TRANSP AEREO LTDA'
  }, config);

  assert.equal(boleto.registered, true);
  assert.equal(boleto.id, '00000021311');
  assert.equal(boleto.wallet, '09');
  assert.equal(boleto.amount, 724.61);
  assert.equal(boleto.dueDate, '2026-09-24');
  assert.equal(boleto.beneficiaryTaxId, '09123137000108');
});

test('registra boleto convencional sem envelope adicional', async () => {
  resetTokenCache();
  const config = bradescoConfig(configEnvironment());
  const requests = [];
  const request = async (options) => {
    requests.push(options);
    if (options.url === config.tokenUrl) {
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: 'token', expires_in: 3600 }))
      };
    }
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({
        nuTituloGerado: 21311,
        idProduto: 9,
        linhaDigitavel: '23797.21802 90000.002130 11000.007408 7 15790000072461',
        vlTitulo: 72461,
        quantidadeCasas: 2,
        dtVencimentoBoleto: '24/09/2026'
      }))
    };
  };

  const boleto = await createBradescoBankSlip({ nuCliente: 'FAT11777' }, { config, request });
  assert.equal(boleto.id, '00000021311');
  assert.equal(requests[1].url, config.registrationUrl);
  assert.equal(requests[1].headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(requests[1].body), { nuCliente: 'FAT11777' });
});

test('marca como incerto um erro 5xx inválido após iniciar o registro', async () => {
  resetTokenCache();
  const config = bradescoConfig(configEnvironment());
  const request = async (options) => {
    if (options.url === config.tokenUrl) {
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: 'token', expires_in: 3600 }))
      };
    }
    return {
      statusCode: 500,
      headers: {},
      body: Buffer.from('resposta-invalida')
    };
  };

  await assert.rejects(
    createBradescoBankSlip({ nuCliente: 'FAT11777' }, { config, request }),
    (error) => error.statusCode === 502 && error.ambiguousBankState === true
  );
});

test('consulta a segunda via com o formato de negociação de 11 dígitos', async () => {
  resetTokenCache();
  const config = bradescoConfig(configEnvironment());
  const requests = [];
  const request = async (options) => {
    requests.push(options);
    if (options.url === config.tokenUrl) {
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: 'token', expires_in: 3600 }))
      };
    }
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({
        status: 200,
        titulo: {
          linhaDig: '23797.21802 90000.002130 11000.007408 7 15790000072461',
          valorMoedaBol: 72461,
          qtdeCas: 2,
          dataVenctoBol: '24/09/2026',
          snumero: 'FAT11777'
        }
      }))
    };
  };

  const boleto = await queryBradescoBankSlip('00000021311', { config, request });
  const body = JSON.parse(requests[1].body);
  assert.equal(requests[1].url, config.queryUrl);
  assert.deepEqual(body, {
    cpfCnpj: { cpfCnpj: '09123137', filial: '0001', controle: '08' },
    produto: '09',
    negociacao: '72180000074',
    nossoNumero: '00000021311',
    sequencia: '0',
    status: '0'
  });
  assert.equal(boleto.id, '00000021311');
});
