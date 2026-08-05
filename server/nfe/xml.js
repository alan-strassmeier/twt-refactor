const { XMLParser } = require('fast-xml-parser');

const MAX_XML_SIZE = 1_500_000;
const ACCESS_KEY_PATTERN = /^\d{44}$/;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: true
});

const httpError = (message, statusCode = 422) =>
  Object.assign(new Error(message), { statusCode });

const text = (value) => value == null ? '' : String(value).trim();
const digits = (value) => text(value).replace(/\D/g, '');
const number = (value) => {
  const parsed = Number(text(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
const integer = (value) => Math.max(0, Math.trunc(number(value)));
const asArray = (value) => value == null ? [] : (Array.isArray(value) ? value : [value]);

const accessKeyCheckDigit = (first43Digits) => {
  if (!/^\d{43}$/.test(first43Digits)) return -1;
  let weight = 2;
  let sum = 0;
  for (let index = first43Digits.length - 1; index >= 0; index -= 1) {
    sum += Number(first43Digits[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const result = 11 - (sum % 11);
  return result === 10 || result === 11 ? 0 : result;
};

const isValidAccessKey = (value) => {
  const key = digits(value);
  return ACCESS_KEY_PATTERN.test(key) &&
    accessKeyCheckDigit(key.slice(0, 43)) === Number(key[43]);
};

const party = (entity = {}, address = {}) => ({
  document: digits(entity.CNPJ || entity.CPF),
  stateRegistration: text(entity.IE),
  name: text(entity.xNome),
  tradeName: text(entity.xFant),
  phone: digits(address.fone),
  street: text(address.xLgr),
  number: text(address.nro),
  complement: text(address.xCpl),
  district: text(address.xBairro),
  cityCode: integer(address.cMun),
  zipCode: integer(digits(address.CEP)),
  countryCode: integer(address.cPais) || 1058,
  email: text(entity.email),
  taxpayerIndicator: integer(entity.indIEDest)
});

const findNfe = (parsed) => {
  const process = parsed?.nfeProc;
  const nfe = process?.NFe || parsed?.NFe;
  const info = nfe?.infNFe;
  if (!info) throw httpError('O arquivo não contém uma NF-e válida.');
  return { process, info };
};

const ensureAuthorized = (process) => {
  const status = text(process?.protNFe?.infProt?.cStat);
  if (status !== '100') {
    throw httpError('A NF-e não possui protocolo de autorização válido (cStat 100).');
  }
};

const parseNfeXml = (xml) => {
  const source = String(xml || '').trim();
  if (!source || Buffer.byteLength(source) > MAX_XML_SIZE) {
    throw httpError('O XML está vazio ou excede 1,5 MB.', 413);
  }

  let parsed;
  try {
    parsed = parser.parse(source);
  } catch {
    throw httpError('Não foi possível interpretar o XML da NF-e.');
  }

  const { process, info } = findNfe(parsed);
  ensureAuthorized(process);

  const protocol = process.protNFe.infProt;
  const key = digits(protocol.chNFe || text(info['@_Id']).replace(/^NFe/i, ''));
  if (!isValidAccessKey(key)) {
    throw httpError('A chave de acesso contida no XML é inválida.');
  }

  const ide = info.ide || {};
  if (text(ide.mod) !== '55') throw httpError('O documento informado não é uma NF-e modelo 55.');

  const emit = info.emit || {};
  const dest = info.dest || {};
  const transport = info.transp || {};
  const totals = info.total?.ICMSTot || {};
  const volumes = asArray(transport.vol);
  const items = asArray(info.det);
  const grossWeight = volumes.reduce((sum, volume) => sum + number(volume?.pesoB), 0);
  const volumeCount = volumes.reduce((sum, volume) => sum + integer(volume?.qVol), 0);
  const productNames = [...new Set(items.map((item) => text(item?.prod?.xProd)).filter(Boolean))];
  const cfop = items.map((item) => integer(item?.prod?.CFOP)).find(Boolean) || 0;
  const issueTimestamp = text(ide.dhEmi || ide.dEmi);
  const issueDate = issueTimestamp.slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw httpError('A data de emissão da NF-e é inválida.');
  }

  return {
    xml: source,
    key,
    number: text(ide.nNF),
    series: text(ide.serie),
    issueDate,
    operationNature: text(ide.natOp),
    merchandiseNature: productNames.join(', ').slice(0, 255) || text(ide.natOp),
    cfop,
    freightMode: integer(transport.modFrete),
    insuranceResponsible: integer(transport?.seg?.respSeg),
    issuer: party(emit, emit.enderEmit || {}),
    recipient: party(dest, dest.enderDest || {}),
    cargo: {
      grossWeight,
      cubedWeight: 0,
      volumeCount: volumeCount || 1,
      species: text(volumes.find((volume) => text(volume?.esp))?.esp) || 'VOLUMES',
      productValue: number(totals.vProd),
      invoiceValue: number(totals.vNF),
      icmsBase: number(totals.vBC),
      icmsValue: number(totals.vICMS),
      icmsStBase: number(totals.vBCST),
      icmsStValue: number(totals.vST)
    }
  };
};

module.exports = {
  MAX_XML_SIZE,
  accessKeyCheckDigit,
  isValidAccessKey,
  parseNfeXml
};

