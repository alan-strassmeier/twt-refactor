const assert = require('node:assert/strict');
const test = require('node:test');
const { gzipSync } = require('node:zlib');
const forge = require('node-forge');

const {
  certificateMaterialFromPfx,
  nfseConfig
} = require('../server/faturamento/nfse-config');
const {
  dpsIdFor,
  buildDpsXml,
  signDpsXml
} = require('../server/faturamento/nfse-xml');
const {
  FISCAL_STANDARD,
  resolveInvoiceNfseData,
  metadataFromAuthorizedXml,
  issueInvoiceNfse
} = require('../server/faturamento/nfse');
const {
  decodeAuthorizedXml,
  postDps
} = require('../server/faturamento/nfse-client');
const {
  parseNfseXml,
  buildDanfsePdf
} = require('../server/faturamento/danfse');
const { nfseStorageConfig } = require('../server/faturamento/nfse-storage');
const {
  agentConfigFromEnv,
  publicAgentJob,
  completeAgentJob
} = require('../server/faturamento/nfse-agent');

const ACCESS_KEY = '43149022209123137000108000000000032526072661569945';

const AUTHORIZED_XML = `<?xml version="1.0" encoding="utf-8"?>
<NFSe versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infNFSe Id="NFS${ACCESS_KEY}">
    <xLocEmi>Porto Alegre</xLocEmi><xLocPrestacao>Porto Alegre</xLocPrestacao>
    <nNFSe>325</nNFSe><cLocIncid>4314902</cLocIncid><xLocIncid>Porto Alegre</xLocIncid>
    <xTribNac>Coleta e entrega de documentos, bens e valores.</xTribNac>
    <xNBS>Serviços de coleta e entrega de cargas no transporte multimodal</xNBS>
    <dhProc>2026-07-24T15:36:30-03:00</dhProc>
    <emit><CNPJ>09123137000108</CNPJ><xNome>TWT AIRPACK SERVICOS AUXILIARES DE TRANSPORTE AEREO LTDA</xNome>
      <enderNac><xLgr>RUA NICOLAU ELY</xLgr><nro>352</nro><xBairro>FLORESTA</xBairro><cMun>4314902</cMun><UF>RS</UF><CEP>91040631</CEP></enderNac>
      <fone>5133424425</fone><email>faturamento@twt.com.br</email>
    </emit>
    <valores><vLiq>143.59</vLiq></valores>
    <DPS versao="1.01"><infDPS Id="DPS431490220912313700010870000000000000000062">
      <tpAmb>1</tpAmb><dhEmi>2026-07-24T15:36:30-03:00</dhEmi><verAplic>TWT_1.0.0</verAplic>
      <serie>70000</serie><nDPS>62</nDPS><dCompet>2026-07-16</dCompet><tpEmit>1</tpEmit><cLocEmi>4314902</cLocEmi>
      <prest><CNPJ>09123137000108</CNPJ><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>
      <toma><CNPJ>28759933000186</CNPJ><xNome>SENSITIVE TRANSPORTES LTDA</xNome><end><endNac><cMun>3534401</cMun><CEP>06278010</CEP></endNac><xLgr>DOUTOR MAURO LINDEMBERG MONTEIRO</xLgr><nro>185</nro><xCpl>GALPAO16</xCpl><xBairro>SANTA FE</xBairro></end></toma>
      <serv><locPrest><cLocPrestacao>4314902</cLocPrestacao></locPrest><cServ><cTribNac>150603</cTribNac><xDescServ>SERVICOS DE DISTRIBUICAO CONF FAT 11518</xDescServ><cNBS>106081000</cNBS></cServ></serv>
      <valores><vServPrest><vServ>143.59</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><tribFed><piscofins><CST>00</CST></piscofins></tribFed><totTrib><pTotTribSN>5.97</pTotTribSN></totTrib></trib></valores>
    </infDPS></DPS>
  </infNFSe>
</NFSe>`;

const createCertificate = () => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  const attributes = [{ name: 'commonName', value: 'TWT Teste' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certificate, 'senha-teste', {
    algorithm: '3des'
  });
  return {
    pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(certificate)
  };
};

const fiscal = (material = {}) => ({
  ...FISCAL_STANDARD,
  environmentType: '2',
  series: '81001',
  applicationVersion: 'TWT_1.0.0',
  providerPhone: '5133424425',
  providerEmail: 'faturamento@twt.com.br',
  ...material
});

const client = {
  document: '28759933000186',
  name: 'SENSITIVE TRANSPORTES LTDA',
  municipalityCode: '3534401',
  zipCode: '06278010',
  street: 'DOUTOR MAURO LINDEMBERG MONTEIRO',
  number: '185',
  complement: 'GALPAO16',
  district: 'SANTA FE'
};

test('forma o Id oficial da DPS com série e sequencial exclusivos', () => {
  assert.equal(dpsIdFor({
    municipalityCode: '4314902',
    issuerCnpj: '09123137000108',
    series: '81001',
    dpsNumber: 63
  }), 'DPS431490220912313700010881001000000000000063');
});

test('usa a emissão da fatura como competência e bloqueia emitente diferente da TWT', async () => {
  const dependencies = {
    requestExactInvoice: async () => ({ invoice: {
      fatura: 11518,
      cnpj_cliente: '28.759.933/0001-86',
      status: '0',
      valor: '143.59',
      emissao: '2026-07-16'
    } }),
    findDoccobForInvoice: async () => ({
      invoice: { issuerCnpj: '09123137000108' },
      transports: []
    }),
    fetchCompany: async () => ({
      cnpj: client.document,
      razao: client.name,
      codigo_ibge: client.municipalityCode,
      cep: client.zipCode,
      endereco: client.street,
      numero: client.number,
      complemento: client.complement,
      bairro: client.district
    })
  };
  const result = await resolveInvoiceNfseData('11518', dependencies);
  assert.equal(result.invoice.competence, '2026-07-16');
  assert.equal(result.invoice.amount, 143.59);
  assert.equal(result.invoice.description, 'SERVICOS DE DISTRIBUICAO CONF FAT 11518');

  await assert.rejects(
    () => resolveInvoiceNfseData('11518', {
      ...dependencies,
      findDoccobForInvoice: async () => ({ invoice: { issuerCnpj: '97434690000129' } })
    }),
    /somente para faturas da TWT/
  );
});

test('monta e assina a DPS 1.01 com os dados fiscais confirmados', () => {
  const material = createCertificate();
  const built = buildDpsXml({
    fiscal: fiscal(),
    client,
    invoice: {
      id: '11518',
      competence: '2026-07-16',
      amount: 143.59,
      description: 'SERVICOS DE DISTRIBUICAO CONF FAT 11518'
    },
    dpsNumber: 63,
    issuedAt: new Date('2026-08-11T15:00:00Z')
  });
  assert.match(built.xml, /<dCompet>2026-07-16<\/dCompet>/);
  assert.match(built.xml, /<cTribNac>150603<\/cTribNac>/);
  assert.match(built.xml, /<cNBS>106081000<\/cNBS>/);
  assert.match(built.xml, /<pTotTribSN>5\.97<\/pTotTribSN>/);
  const signed = signDpsXml(built.xml, material);
  assert.match(signed, /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
  assert.match(signed, new RegExp(`<Reference URI="#${built.dpsId}">`));
  assert.match(signed, /<X509Certificate>[^<]+<\/X509Certificate>/);
});

test('lê certificado A1 em PKCS#12 e mantém homologação como padrão', () => {
  const material = createCertificate();
  const parsed = certificateMaterialFromPfx(material.pfx, 'senha-teste');
  assert.match(parsed.privateKeyPem, /BEGIN RSA PRIVATE KEY/);
  assert.match(parsed.certificatePem, /BEGIN CERTIFICATE/);
  const config = nfseConfig({
    NFSE_DPS_SERIES: '81001',
    NFSE_CERT_PFX_BASE64: material.pfx.toString('base64'),
    NFSE_CERT_PASSWORD: 'senha-teste'
  });
  assert.equal(config.environment, 'homologation');
  assert.equal(config.environmentType, '2');
  assert.match(config.baseUrl, /producaorestrita/);
});

test('modo agent dispensa o PFX na Vercel e exige token forte', () => {
  const config = nfseConfig({
    NFSE_CERT_MODE: 'agent',
    NFSE_DPS_SERIES: '81001'
  });
  assert.equal(config.certificateMode, 'agent');
  assert.equal(config.pfx, undefined);
  assert.equal(agentConfigFromEnv({
    NFSE_AGENT_TOKEN: 'a'.repeat(48),
    NFSE_AGENT_LEASE_MS: '600000'
  }).leaseMs, 600000);
  assert.throws(() => agentConfigFromEnv({ NFSE_AGENT_TOKEN: 'curto' }), /32 caracteres/);
});

test('decodifica resposta autorizada, chave em infNFSe e gera DANFSe', async () => {
  const payload = {
    nfseXmlGZipB64: gzipSync(Buffer.from(AUTHORIZED_XML)).toString('base64')
  };
  assert.equal(decodeAuthorizedXml(payload), AUTHORIZED_XML);
  assert.deepEqual(metadataFromAuthorizedXml(AUTHORIZED_XML), {
    accessKey: ACCESS_KEY,
    nfseNumber: '325',
    processedAt: '2026-07-24T15:36:30-03:00',
    dpsNumber: '62',
    dpsSeries: '70000'
  });
  const parsed = parseNfseXml(AUTHORIZED_XML);
  assert.equal(parsed.accessKey, ACCESS_KEY);
  assert.equal(parsed.competence, '16/07/2026');
  const pdf = await buildDanfsePdf(AUTHORIZED_XML);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 5000);
});

test('envia a DPS compactada no contrato JSON oficial', async () => {
  const result = await postDps('<DPS>teste</DPS>', {
    config: { baseUrl: 'https://example.test/api', requestTimeoutMs: 1000 },
    request: async (request) => {
      assert.equal(request.url, 'https://example.test/api/nfse');
      assert.equal(request.method, 'POST');
      const body = JSON.parse(request.body);
      assert.match(body.dpsXmlGZipB64, /^[A-Za-z0-9+/]+=*$/);
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          chaveAcesso: ACCESS_KEY,
          nfseXmlGZipB64: gzipSync(Buffer.from(AUTHORIZED_XML)).toString('base64')
        }))
      };
    }
  });
  assert.equal(result.chaveAcesso, ACCESS_KEY);
  assert.equal(result.xml, AUTHORIZED_XML);
});

test('resposta de sucesso sem XML fica em revisão para não duplicar a NFS-e', async () => {
  await assert.rejects(
    () => postDps('<DPS>teste</DPS>', {
      config: { baseUrl: 'https://example.test/api', requestTimeoutMs: 1000 },
      request: async () => ({
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ chaveAcesso: ACCESS_KEY }))
      })
    }),
    (error) => error.ambiguousNfseState === true
  );
});

test('isola a escrita dos XMLs em credenciais R2 próprias quando configuradas', () => {
  const config = nfseStorageConfig({
    R2_ACCOUNT_ID: 'conta-leitura',
    R2_ACCESS_KEY_ID: 'leitura',
    R2_SECRET_ACCESS_KEY: 'segredo-leitura',
    R2_BUCKET_NAME: 'doccobs',
    R2_NFSE_ACCOUNT_ID: 'conta-nfse',
    R2_NFSE_ACCESS_KEY_ID: 'escrita',
    R2_NFSE_SECRET_ACCESS_KEY: 'segredo-escrita',
    R2_NFSE_BUCKET_NAME: 'notas-fiscais',
    R2_NFSE_PREFIX: 'autorizadas'
  });
  assert.equal(config.accountId, 'conta-nfse');
  assert.equal(config.accessKeyId, 'escrita');
  assert.equal(config.bucket, 'notas-fiscais');
  assert.equal(config.nfsePrefix, 'autorizadas');
});

test('emite uma vez, guarda o XML autorizado e reaproveita o vínculo da fatura', async () => {
  const material = createCertificate();
  let record = null;
  let transmissions = 0;
  const dependencies = {
    config: {
      environment: 'homologation',
      environmentType: '2',
      baseUrl: 'https://example.test',
      series: '81001',
      initialNumber: 0,
      applicationVersion: 'TWT_1.0.0',
      providerPhone: '5133424425',
      providerEmail: 'faturamento@twt.com.br',
      ...material
    },
    requestExactInvoice: async () => ({ invoice: {
      fatura: 11518,
      cnpj_cliente: client.document,
      status: '0',
      valor: '143.59',
      emissao: '2026-07-16'
    } }),
    findDoccobForInvoice: async () => ({ invoice: { issuerCnpj: '09123137000108' } }),
    fetchCompany: async () => ({
      cnpj: client.document,
      razao: client.name,
      codigo_ibge: client.municipalityCode,
      cep: client.zipCode,
      endereco: client.street,
      numero: client.number,
      complemento: client.complement,
      bairro: client.district
    }),
    getNfseRecord: async () => record,
    claimNfse: async (_invoiceId, value) => {
      if (record) return false;
      record = value;
      return true;
    },
    saveNfseRecord: async (_invoiceId, value) => { record = value; },
    releaseNfseClaim: async () => { record = null; },
    reserveDpsNumber: async () => 63,
    postDps: async (signedXml) => {
      transmissions += 1;
      assert.match(signedXml, /<Signature/);
      return { chaveAcesso: ACCESS_KEY, xml: AUTHORIZED_XML };
    },
    saveNfseXml: async ({ invoiceId, accessKey, xml }) => {
      assert.equal(invoiceId, '11518');
      assert.equal(accessKey, ACCESS_KEY);
      assert.equal(xml, AUTHORIZED_XML);
      return `nfse/2026/${invoiceId}/${accessKey}.xml`;
    },
    now: new Date('2026-08-11T15:00:00Z')
  };

  const first = await issueInvoiceNfse('11518', dependencies);
  assert.equal(first.created, true);
  assert.equal(first.status, 'issued');
  assert.equal(record.state, 'issued');
  assert.equal(transmissions, 1);

  const second = await issueInvoiceNfse('11518', dependencies);
  assert.equal(second.created, false);
  assert.equal(second.status, 'issued');
  assert.equal(transmissions, 1);
});

test('modo A3 enfileira a DPS sem assinatura e sem transmitir pela Vercel', async () => {
  let record = null;
  let queued = null;
  const dependencies = {
    config: {
      certificateMode: 'agent',
      environment: 'homologation',
      environmentType: '2',
      baseUrl: 'https://example.test',
      series: '81001',
      initialNumber: 0,
      applicationVersion: 'TWT_1.0.0',
      providerPhone: '5133424425',
      providerEmail: 'faturamento@twt.com.br'
    },
    requestExactInvoice: async () => ({ invoice: {
      fatura: 11518,
      cnpj_cliente: client.document,
      status: '0',
      valor: '143.59',
      emissao: '2026-07-16'
    } }),
    findDoccobForInvoice: async () => ({ invoice: { issuerCnpj: '09123137000108' } }),
    fetchCompany: async () => ({
      cnpj: client.document,
      razao: client.name,
      codigo_ibge: client.municipalityCode,
      cep: client.zipCode,
      endereco: client.street,
      numero: client.number,
      complemento: client.complement,
      bairro: client.district
    }),
    getNfseRecord: async () => record,
    claimNfse: async (_invoiceId, value) => {
      if (record) return false;
      record = value;
      return true;
    },
    saveNfseRecord: async (_invoiceId, value) => { record = value; },
    releaseNfseClaim: async () => { record = null; },
    reserveDpsNumber: async () => 64,
    enqueueNfseJob: async (value) => { queued = value; },
    postDps: async () => assert.fail('A Vercel não pode transmitir no modo agent.'),
    now: new Date('2026-08-11T15:00:00Z')
  };

  const result = await issueInvoiceNfse('11518', dependencies);
  assert.equal(result.status, 'queued');
  assert.equal(result.created, true);
  assert.equal(record.state, 'queued');
  assert.equal(queued.invoiceId, '11518');
  const unsigned = Buffer.from(record.unsignedDpsBase64, 'base64').toString('utf8');
  assert.match(unsigned, /<DPS/);
  assert.doesNotMatch(unsigned, /<Signature/);

  const firstLease = publicAgentJob({
    ...record,
    attempts: 1,
    leaseToken: 'b'.repeat(64),
    leaseExpiresAt: '2026-08-11T15:05:00.000Z'
  }, dependencies.config);
  assert.equal(firstLease.action, 'issue');
  assert.match(firstLease.unsignedDpsXml, /<DPS/);
  const repeatedLease = publicAgentJob({ ...record, attempts: 2 }, dependencies.config);
  assert.equal(repeatedLease.action, 'recover');
  assert.equal(repeatedLease.unsignedDpsXml, '');
});

test('aceita do agente somente XML autorizado vinculado à concessão', async () => {
  let removed = false;
  const record = {
    state: 'agent_processing',
    invoiceId: '11518',
    environment: 'homologation',
    leaseToken: 'c'.repeat(64),
    agentId: 'twt-fiscal-01',
    competence: '2026-07-16',
    amount: 143.59,
    unsignedDpsBase64: Buffer.from('<DPS/>').toString('base64')
  };
  const result = await completeAgentJob({
    agentId: record.agentId,
    invoiceId: record.invoiceId,
    leaseToken: record.leaseToken,
    outcome: 'issued',
    authorizedXmlGZipB64: gzipSync(Buffer.from(AUTHORIZED_XML)).toString('base64')
  }, {
    getNfseRecord: async () => record,
    assertNfseJobLease: async () => record,
    finalizeAuthorizedDocument: async ({ record: clean, xml }) => {
      assert.equal(clean.leaseToken, undefined);
      assert.equal(clean.unsignedDpsBase64, undefined);
      assert.equal(xml, AUTHORIZED_XML);
      return { ...clean, state: 'issued', accessKey: ACCESS_KEY, nfseNumber: '325' };
    },
    removeNfseJobFromQueue: async () => { removed = true; }
  });
  assert.equal(result.status, 'issued');
  assert.equal(removed, true);
});
