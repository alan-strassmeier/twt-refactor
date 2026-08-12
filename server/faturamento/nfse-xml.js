const { SignedXml } = require('xml-crypto');

const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
const XMLDSIG_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';
const EXCLUSIVE_C14N_WITH_COMMENTS =
  'http://www.w3.org/2001/10/xml-exc-c14n#WithComments';
const ENVELOPED_SIGNATURE = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

const xmlEscape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const cleanText = (value, maximum = 2000) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

const digits = (value) => String(value || '').replace(/\D/g, '');

const decimal = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw Object.assign(new Error('Valor do serviço inválido para emissão da NFS-e.'), {
      statusCode: 422
    });
  }
  return number.toFixed(2);
};

const requiredText = (value, label, maximum) => {
  const text = cleanText(value, maximum);
  if (!text) {
    throw Object.assign(new Error(`${label} não está preenchido.`), { statusCode: 422 });
  }
  return text;
};

const dpsIdFor = ({ municipalityCode, issuerCnpj, series, dpsNumber }) => {
  const municipality = digits(municipalityCode);
  const issuer = digits(issuerCnpj);
  const normalizedSeries = digits(series);
  const number = String(dpsNumber || '').replace(/\D/g, '');
  if (municipality.length !== 7 || issuer.length !== 14 || !/^\d{1,5}$/.test(normalizedSeries)) {
    throw new Error('Dados inválidos para formar o identificador da DPS.');
  }
  if (!/^[1-9]\d{0,14}$/.test(number)) {
    throw new Error('Número da DPS inválido.');
  }
  return `DPS${municipality}2${issuer}${normalizedSeries.padStart(5, '0')}${number.padStart(15, '0')}`;
};

const timeZoneOffset = (date, timeZone) => {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset'
  }).formatToParts(date).find((item) => item.type === 'timeZoneName')?.value || 'GMT-03:00';
  return part.replace(/^GMT/, '') || '-03:00';
};

const dateTimeInZone = (date = new Date(), timeZone = 'America/Sao_Paulo') => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${timeZoneOffset(date, timeZone)}`;
};

const addressXml = (client) => {
  const municipalityCode = digits(client.municipalityCode);
  const zipCode = digits(client.zipCode);
  if (municipalityCode.length !== 7 || zipCode.length !== 8) {
    throw Object.assign(new Error('Município IBGE e CEP do tomador são obrigatórios.'), {
      statusCode: 422
    });
  }
  const street = requiredText(client.street, 'Logradouro do tomador', 255);
  const number = requiredText(client.number, 'Número do endereço do tomador', 60);
  const district = requiredText(client.district, 'Bairro do tomador', 60);
  const complement = cleanText(client.complement, 156);
  return [
    '<end>',
    `<endNac><cMun>${municipalityCode}</cMun><CEP>${zipCode}</CEP></endNac>`,
    `<xLgr>${xmlEscape(street)}</xLgr>`,
    `<nro>${xmlEscape(number)}</nro>`,
    complement ? `<xCpl>${xmlEscape(complement)}</xCpl>` : '',
    `<xBairro>${xmlEscape(district)}</xBairro>`,
    '</end>'
  ].join('');
};

const buildDpsXml = ({ fiscal, client, invoice, dpsNumber, issuedAt = new Date() }) => {
  const issuerCnpj = digits(fiscal.issuerCnpj);
  const clientCnpj = digits(client.document);
  const municipalityCode = digits(fiscal.municipalityCode);
  if (issuerCnpj.length !== 14 || clientCnpj.length !== 14) {
    throw Object.assign(new Error('CNPJ do prestador ou tomador inválido.'), { statusCode: 422 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(invoice.competence || ''))) {
    throw Object.assign(new Error('Data de competência da NFS-e inválida.'), { statusCode: 422 });
  }
  const dpsId = dpsIdFor({
    municipalityCode,
    issuerCnpj,
    series: fiscal.series,
    dpsNumber
  });
  const description = requiredText(
    invoice.description || `SERVICOS DE DISTRIBUICAO CONF FAT ${invoice.id}`,
    'Descrição do serviço',
    2000
  );

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<DPS versao="1.01" xmlns="${NFSE_NAMESPACE}">`,
    `<infDPS Id="${dpsId}">`,
    `<tpAmb>${xmlEscape(fiscal.environmentType)}</tpAmb>`,
    `<dhEmi>${dateTimeInZone(issuedAt)}</dhEmi>`,
    `<verAplic>${xmlEscape(requiredText(fiscal.applicationVersion, 'Versão do aplicativo', 20))}</verAplic>`,
    `<serie>${xmlEscape(String(fiscal.series))}</serie>`,
    `<nDPS>${xmlEscape(String(dpsNumber))}</nDPS>`,
    `<dCompet>${xmlEscape(invoice.competence)}</dCompet>`,
    '<tpEmit>1</tpEmit>',
    `<cLocEmi>${municipalityCode}</cLocEmi>`,
    '<prest>',
    `<CNPJ>${issuerCnpj}</CNPJ>`,
    fiscal.providerPhone ? `<fone>${xmlEscape(digits(fiscal.providerPhone))}</fone>` : '',
    fiscal.providerEmail ? `<email>${xmlEscape(cleanText(fiscal.providerEmail, 80))}</email>` : '',
    '<regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib>',
    '</prest>',
    '<toma>',
    `<CNPJ>${clientCnpj}</CNPJ>`,
    `<xNome>${xmlEscape(requiredText(client.name, 'Razão social do tomador', 150))}</xNome>`,
    addressXml(client),
    '</toma>',
    '<serv>',
    `<locPrest><cLocPrestacao>${municipalityCode}</cLocPrestacao></locPrest>`,
    '<cServ>',
    `<cTribNac>${xmlEscape(fiscal.serviceCode)}</cTribNac>`,
    `<xDescServ>${xmlEscape(description)}</xDescServ>`,
    `<cNBS>${xmlEscape(fiscal.nbsCode)}</cNBS>`,
    '</cServ>',
    '</serv>',
    '<valores>',
    `<vServPrest><vServ>${decimal(invoice.amount)}</vServ></vServPrest>`,
    '<trib>',
    '<tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>',
    '<tribFed><piscofins><CST>00</CST></piscofins></tribFed>',
    `<totTrib><pTotTribSN>${decimal(fiscal.totalTaxPercentage)}</pTotTribSN></totTrib>`,
    '</trib>',
    '</valores>',
    '</infDPS>',
    '</DPS>'
  ].join('');

  return { xml, dpsId };
};

const signDpsXml = (xml, { privateKeyPem, certificatePem }) => {
  if (!privateKeyPem || !certificatePem) throw new Error('Certificado de assinatura não informado.');
  const signer = new SignedXml({
    idAttribute: 'Id',
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: EXCLUSIVE_C14N_WITH_COMMENTS,
    getKeyInfoContent: SignedXml.getKeyInfoContent
  });
  signer.addReference({
    xpath: "//*[local-name(.)='infDPS']",
    transforms: [ENVELOPED_SIGNATURE, EXCLUSIVE_C14N_WITH_COMMENTS],
    digestAlgorithm: SHA256
  });
  signer.computeSignature(xml, {
    prefix: '',
    location: {
      reference: "//*[local-name(.)='infDPS']",
      action: 'after'
    },
    existingPrefixes: { ds: XMLDSIG_NAMESPACE }
  });
  return signer.getSignedXml();
};

module.exports = {
  NFSE_NAMESPACE,
  XMLDSIG_NAMESPACE,
  EXCLUSIVE_C14N_WITH_COMMENTS,
  xmlEscape,
  cleanText,
  dpsIdFor,
  dateTimeInZone,
  addressXml,
  buildDpsXml,
  signDpsXml
};
