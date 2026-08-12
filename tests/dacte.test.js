const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeCteKeys,
  resolveInvoiceCteKeys,
  decodeCteXmlPayload,
  accessKeyFromXml,
  fetchCteXmls
} = require('../server/faturamento/cte-documents');
const {
  parseCteXml,
  buildDactePdf,
  flowPassageFrom
} = require('../server/faturamento/dacte');

const KEY = '43260797434690000129570000000151221704715130';
const XML = `<?xml version="1.0" encoding="utf-8"?>
<cteProc xmlns="http://www.portalfiscal.inf.br/cte">
  <CTe><infCte Id="CTe${KEY}" versao="4.00">
    <ide><CFOP>6932</CFOP><natOp>PRESTACAO DE SERVICO DE TRANSPORTE</natOp><mod>57</mod><serie>0</serie><nCT>15122</nCT><dhEmi>2026-07-16T17:19:02-03:00</dhEmi><modal>01</modal><tpServ>2</tpServ><tpCTe>0</tpCTe><xMunIni>ITAJAI</xMunIni><UFIni>SC</UFIni><xMunFim>ITAUNA</xMunFim><UFFim>MG</UFFim><toma3><toma>0</toma></toma3></ide>
    <compl><xEmi>LUCAS DA CRUZ FOCHEZ</xEmi><fluxo><xOrig>NVT</xOrig><xDest>PLU</xDest></fluxo><Entrega><comData><dProg>2026-07-23</dProg></comData></Entrega><xObs>Observação completa do transporte.</xObs><ObsCont xCampo="minuta"><xTexto>0000024885</xTexto></ObsCont></compl>
    <emit><CNPJ>97434690000129</CNPJ><IE>0963199668</IE><xNome>DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA</xNome><enderEmit><xLgr>AV SERTORIO</xLgr><nro>4455</nro><xBairro>JARDIM SAO PEDRO</xBairro><xMun>PORTO ALEGRE</xMun><CEP>91040621</CEP><UF>RS</UF><fone>5133424425</fone></enderEmit></emit>
    <rem><CNPJ>41870054000276</CNPJ><IE>262774143</IE><xNome>JIMI BRASIL LTDA</xNome><enderReme><xLgr>R FRANCISCO REIS</xLgr><nro>1402</nro><xBairro>CORDEIROS</xBairro><xMun>ITAJAI</xMun><CEP>88311750</CEP><UF>SC</UF></enderReme></rem>
    <dest><CNPJ>14003291000186</CNPJ><IE>0022284570062</IE><xNome>RAJASOFT SOLUCOES EM TECNOLOGIA LTDA</xNome><enderDest><xLgr>R CANDIDO GUIMARAES</xLgr><nro>134</nro><xBairro>VEREDAS</xBairro><xMun>ITAUNA</xMun><CEP>35681273</CEP><UF>MG</UF></enderDest></dest>
    <vPrest><vTPrest>2272.90</vTPrest><vRec>2272.90</vRec><Comp><xNome>FRETE PESO</xNome><vComp>870.00</vComp></Comp></vPrest>
    <imp><ICMS><ICMSSN><CST>90</CST><indSN>1</indSN></ICMSSN></ICMS></imp>
    <infCTeNorm><infCarga><vCarga>100995.94</vCarga><proPred>DIVERSOS</proPred><infQ><tpMed>PESO BRUTO</tpMed><qCarga>130.5000</qCarga></infQ><infQ><tpMed>VOLUMES</tpMed><qCarga>14.0000</qCarga></infQ></infCarga><infDoc><infNFe><chave>42260741870054000276550010000017761819198958</chave></infNFe></infDoc><infModal><rodo><RNTRC>02218852</RNTRC></rodo></infModal></infCTeNorm>
  </infCte><infCTeSupl><qrCodCTe><![CDATA[https://example.test/cte?chCTe=${KEY}]]></qrCodCTe></infCTeSupl></CTe>
  <protCTe><infProt><chCTe>${KEY}</chCTe><dhRecbto>2026-07-16T17:19:04-03:00</dhRecbto><nProt>143260190272193</nProt><xMotivo>Autorizado o uso do CT-e</xMotivo></infProt></protCTe>
</cteProc>`;

test('localiza os CT-es da fatura pelo DOCCOB sem depender da empresa', async () => {
  const result = await resolveInvoiceCteKeys('11532', {
    requestExactInvoice: async () => ({
      invoice: { fatura: 11532, cnpj_cliente: '41.870.054/0002-76' }
    }),
    findDoccobForInvoice: async (input) => {
      assert.deepEqual(input, { invoiceId: 11532, clientCnpj: '41870054000276' });
      return { transports: [{ accessKey: KEY }, { accessKey: KEY }] };
    }
  });
  assert.deepEqual(result.cteKeys, [KEY]);
  assert.equal(result.source, 'doccob');
});

test('fatura sem chave de CT-e não oferece DACTE', async () => {
  const result = await resolveInvoiceCteKeys('11518', {
    requestExactInvoice: async () => ({
      invoice: { fatura: 11518, cnpj_cliente: '28.759.933/0001-86' }
    }),
    findDoccobForInvoice: async () => ({ transports: [{ accessKey: null }] })
  });
  assert.deepEqual(result.cteKeys, []);
});

test('decodifica o XML base64 retornado por GET /dfe/cte', async () => {
  const payload = { status: 1, data: { xml: Buffer.from(XML).toString('base64') } };
  assert.deepEqual(decodeCteXmlPayload(payload), [XML]);
  assert.equal(accessKeyFromXml(XML), KEY);

  let requestedPath = '';
  const xmls = await fetchCteXmls([KEY], async (path) => {
    requestedPath = path;
    return { response: { ok: true, status: 200 }, payload };
  });
  assert.match(requestedPath, /^\/dfe\/cte\?chave=/);
  assert.equal(new URLSearchParams(requestedPath.split('?')[1]).get('chave'), KEY);
  assert.deepEqual(xmls, [XML]);
});

test('normaliza somente chaves CT-e válidas e limita duplicidades', () => {
  assert.deepEqual(normalizeCteKeys([KEY, KEY, '123']), [KEY]);
});

test('separa somente os pontos intermediários no fluxo da carga', () => {
  assert.equal(flowPassageFrom('|PLU', 'NVT', 'PLU'), '');
  assert.equal(flowPassageFrom('|NVT|GRU|VCP|PLU', 'NVT', 'PLU'), 'GRU - VCP');
});

test('interpreta o XML e gera um DACTE por página', async () => {
  const model = parseCteXml(XML);
  assert.equal(model.accessKey, KEY);
  assert.equal(model.number, '15122');
  assert.equal(model.minute, '0000024885');
  assert.equal(model.parties.sender.name, 'JIMI BRASIL LTDA');
  assert.equal(model.parties.taker.type, 'REMETENTE');
  assert.equal(model.flow.origin, 'NVT');
  assert.equal(model.flow.passage, '');
  assert.equal(model.flow.destination, 'PLU');
  assert.equal(model.totalService, '2.272,90');
  assert.equal(model.documents[0].number, '42260741870054000276550010000017761819198958');

  const pdf = await buildDactePdf([model, model]);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 2);
});
