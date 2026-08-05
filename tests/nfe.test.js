const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { gzipSync } = require('node:zlib');
const {
  accessKeyCheckDigit,
  isValidAccessKey,
  parseNfeXml
} = require('../server/nfe/xml');
const {
  authenticateCredentials,
  createSessionToken,
  verifySessionToken
} = require('../server/nfe/auth');
const {
  PRODUCTION_URL,
  buildRequestEnvelope,
  parseSoapResponse,
  fetchXmlByKey,
  setTransportForTests,
  resetMemoryForTests: resetSefazMemoryForTests
} = require('../server/nfe/sefaz');
const { runOnce, resetMemoryForTests } = require('../server/nfe/store');
const nfeApi = require('../api/nfe');

const makeAccessKey = () => {
  const first43Digits = '4326079743469000012955001000000123112345678';
  assert.equal(first43Digits.length, 43);
  return `${first43Digits}${accessKeyCheckDigit(first43Digits)}`;
};

const sampleXml = (key = makeAccessKey()) => `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${key}" versao="4.00">
      <ide>
        <cUF>43</cUF>
        <natOp>VENDA DE MERCADORIA</natOp>
        <mod>55</mod>
        <serie>1</serie>
        <nNF>123</nNF>
        <dhEmi>2026-07-26T10:30:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>11111111000191</CNPJ>
        <xNome>REMETENTE TESTE LTDA</xNome>
        <xFant>REMETENTE</xFant>
        <IE>1234567890</IE>
        <enderEmit>
          <xLgr>RUA DE TESTE</xLgr>
          <nro>100</nro>
          <xBairro>CENTRO</xBairro>
          <cMun>4314902</cMun>
          <xMun>PORTO ALEGRE</xMun>
          <UF>RS</UF>
          <CEP>91040621</CEP>
          <cPais>1058</cPais>
          <fone>5133334444</fone>
        </enderEmit>
      </emit>
      <dest>
        <CNPJ>22222222000191</CNPJ>
        <xNome>DESTINATARIO TESTE LTDA</xNome>
        <IE>9876543210</IE>
        <indIEDest>1</indIEDest>
        <email>destino@example.com</email>
        <enderDest>
          <xLgr>AVENIDA DESTINO</xLgr>
          <nro>200</nro>
          <xBairro>INDUSTRIAL</xBairro>
          <cMun>3550308</cMun>
          <xMun>SAO PAULO</xMun>
          <UF>SP</UF>
          <CEP>01001000</CEP>
          <cPais>1058</cPais>
          <fone>1133334444</fone>
        </enderDest>
      </dest>
      <det nItem="1">
        <prod>
          <cProd>ABC</cProd>
          <xProd>EQUIPAMENTO ELETRONICO</xProd>
          <CFOP>6102</CFOP>
          <qCom>2.0000</qCom>
          <vProd>1500.00</vProd>
        </prod>
      </det>
      <total>
        <ICMSTot>
          <vBC>1500.00</vBC>
          <vICMS>180.00</vICMS>
          <vBCST>0.00</vBCST>
          <vST>0.00</vST>
          <vProd>1500.00</vProd>
          <vNF>1500.00</vNF>
        </ICMSTot>
      </total>
      <transp>
        <modFrete>0</modFrete>
        <seg><respSeg>1</respSeg></seg>
        <vol>
          <qVol>2</qVol>
          <esp>CAIXAS</esp>
          <pesoB>18.500</pesoB>
        </vol>
      </transp>
    </infNFe>
  </NFe>
  <protNFe versao="4.00">
    <infProt>
      <chNFe>${key}</chNFe>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso da NF-e</xMotivo>
    </infProt>
  </protNFe>
</nfeProc>`;

const sefazSoapResponse = (xml = sampleXml()) => {
  const compressed = gzipSync(Buffer.from(xml)).toString('base64');
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDistDFeInteresseResult>
        <retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>1</tpAmb>
          <verAplic>1.7.1</verAplic>
          <cStat>138</cStat>
          <xMotivo>Documento localizado</xMotivo>
          <dhResp>2026-07-26T12:00:00-03:00</dhResp>
          <loteDistDFeInt>
            <docZip NSU="000000000000001" schema="procNFe_v4.00.xsd">${compressed}</docZip>
          </loteDistDFeInt>
        </retDistDFeInt>
      </nfeDistDFeInteresseResult>
    </nfeDistDFeInteresseResponse>
  </soap:Body>
</soap:Envelope>`;
};

test('valida chave NF-e pelo dígito verificador', () => {
  const key = makeAccessKey();
  assert.equal(isValidAccessKey(key), true);
  assert.equal(isValidAccessKey(`${key.slice(0, -1)}${(Number(key.at(-1)) + 1) % 10}`), false);
  assert.equal(isValidAccessKey('1'.repeat(43)), false);
});

test('interpreta XML autorizado e preserva dados fiscais essenciais', () => {
  const nfe = parseNfeXml(sampleXml());
  assert.equal(nfe.key, makeAccessKey());
  assert.equal(nfe.number, '123');
  assert.equal(nfe.series, '1');
  assert.equal(nfe.issueDate, '2026-07-26');
  assert.equal(nfe.issuer.document, '11111111000191');
  assert.equal(nfe.recipient.document, '22222222000191');
  assert.equal(nfe.cargo.volumeCount, 2);
  assert.equal(nfe.cargo.grossWeight, 18.5);
  assert.equal(nfe.cargo.invoiceValue, 1500);
  assert.equal(nfe.cfop, 6102);
});

test('recusa XML sem protocolo de autorização', () => {
  const xml = sampleXml().replace('<cStat>100</cStat>', '<cStat>101</cStat>');
  assert.throws(() => parseNfeXml(xml), /protocolo de autorização válido/);
});

test('sessão assinada aceita apenas credenciais configuradas e expira', () => {
  process.env.NFE_PORTAL_USER = 'twt';
  process.env.NFE_PORTAL_PASSWORD = 'senha-segura-de-teste';
  process.env.NFE_SESSION_SECRET = 'segredo-de-teste-com-pelo-menos-32-caracteres';
  const now = Date.parse('2026-07-26T12:00:00Z');

  assert.equal(authenticateCredentials('twt', 'senha-segura-de-teste'), true);
  assert.equal(authenticateCredentials('twt', 'errada'), false);
  const token = createSessionToken(now);
  assert.equal(verifySessionToken(token, now + 1000), true);
  assert.equal(verifySessionToken(`${token}x`, now + 1000), false);
  assert.equal(verifySessionToken(token, now + 9 * 60 * 60 * 1000), false);
});

test('monta consulta oficial à SEFAZ sem expor o certificado no XML', () => {
  assert.match(PRODUCTION_URL, /^https:\/\/www1\.nfe\.fazenda\.gov\.br\//);
  const envelope = buildRequestEnvelope(makeAccessKey(), {
    actorCnpj: '97434690000129',
    authorStateCode: '43'
  });
  assert.match(envelope, new RegExp(`<chNFe>${makeAccessKey()}</chNFe>`));
  assert.match(envelope, /<CNPJ>97434690000129<\/CNPJ>/);
  assert.match(envelope, /<cUFAutor>43<\/cUFAutor>/);
  assert.doesNotMatch(envelope, /CERTIFICADO|SENHA|PRIVATE KEY/i);
});

test('descompacta o procNFe retornado pela SEFAZ', () => {
  const xml = parseSoapResponse(sefazSoapResponse());
  assert.match(xml, /<nfeProc/);
  assert.match(xml, new RegExp(makeAccessKey()));
});

test('consulta e baixa o XML diretamente da SEFAZ com transporte autenticado', async () => {
  resetSefazMemoryForTests();
  process.env.SEFAZ_CERTIFICATE_PFX_BASE64 =
    Buffer.from('certificado-pfx-de-teste').toString('base64');
  process.env.SEFAZ_CERTIFICATE_PASSWORD = 'senha-do-certificado-de-teste';
  process.env.SEFAZ_ACTOR_CNPJ = '97434690000129';
  process.env.SEFAZ_AUTHOR_UF_CODE = '43';
  const requests = [];
  setTransportForTests(async (envelope, config) => {
    requests.push({ envelope, config });
    return sefazSoapResponse();
  });
  try {
    const xml = await fetchXmlByKey(makeAccessKey());
    assert.match(xml, /<nfeProc/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].config.actorCnpj, '97434690000129');
    assert.doesNotMatch(requests[0].envelope, /senha-do-certificado/);
  } finally {
    setTransportForTests();
  }
});

test('não executa novamente uma NF-e já concluída', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  resetMemoryForTests();
  let executions = 0;
  const operation = async () => {
    executions += 1;
    return { minuta: '12345', message: 'Documento gerado' };
  };

  const first = await runOnce(makeAccessKey(), operation);
  const second = await runOnce(makeAccessKey(), operation);
  assert.equal(first.minuta, '12345');
  assert.equal(second.minuta, '12345');
  assert.equal(second.alreadyProcessed, true);
  assert.equal(executions, 1);
});

const invokeApi = async ({ method, action, body, cookie = '' }) => {
  const request = Readable.from([]);
  request.method = method;
  request.query = { action };
  request.body = body;
  request.headers = {
    host: 'www.twt.com.br',
    origin: 'https://www.twt.com.br',
    'x-forwarded-host': 'www.twt.com.br',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '198.51.100.10',
    cookie
  };
  request.socket = { remoteAddress: '198.51.100.10' };

  const headers = {};
  let responseBody = '';
  const response = {
    statusCode: 200,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(value = '') {
      responseBody += value;
    }
  };
  await nfeApi(request, response);
  return {
    statusCode: response.statusCode,
    headers,
    body: JSON.parse(responseBody)
  };
};

test('API cria cookie HttpOnly e reconhece a sessão assinada', async () => {
  process.env.NFE_PORTAL_USER = 'twt';
  process.env.NFE_PORTAL_PASSWORD = 'outra-senha-segura-de-teste';
  process.env.NFE_SESSION_SECRET = 'outro-segredo-com-pelo-menos-32-caracteres';

  const login = await invokeApi({
    method: 'POST',
    action: 'login',
    body: { user: 'twt', password: 'outra-senha-segura-de-teste' }
  });
  assert.equal(login.statusCode, 200);
  assert.match(login.headers['set-cookie'], /HttpOnly/);
  assert.match(login.headers['set-cookie'], /SameSite=Strict/);
  assert.match(login.headers['set-cookie'], /Secure/);
  assert.doesNotMatch(login.headers['set-cookie'], /senha-segura/);

  const cookie = login.headers['set-cookie'].split(';')[0];
  const session = await invokeApi({
    method: 'GET',
    action: 'session',
    cookie
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.body.authenticated, true);
});

test('API bloqueia processamento sem sessão', async () => {
  const response = await invokeApi({
    method: 'POST',
    action: 'process',
    body: { keys: [makeAccessKey()] }
  });
  assert.equal(response.statusCode, 401);
  assert.match(response.body.message, /sessão expirou/i);
});

test('API nunca cria uma minuta quando a atualização não está documentada', async () => {
  const originalFetch = global.fetch;
  process.env.NFE_PORTAL_USER = 'twt';
  process.env.NFE_PORTAL_PASSWORD = 'senha-de-integracao-de-teste';
  process.env.NFE_SESSION_SECRET = 'segredo-da-integracao-com-pelo-menos-32-caracteres';
  const brudamRequests = [];

  global.fetch = async (url, options = {}) => {
    brudamRequests.push({ url: String(url), options });
    throw new Error('Nenhuma chamada externa deveria ocorrer.');
  };

  try {
    const login = await invokeApi({
      method: 'POST',
      action: 'login',
      body: { user: 'twt', password: 'senha-de-integracao-de-teste' }
    });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const response = await invokeApi({
      method: 'POST',
      action: 'process',
      cookie,
      body: {
        minuta: '7654321',
        keys: [makeAccessKey()]
      }
    });

    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /minuta existente/i);
    assert.equal(brudamRequests.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

