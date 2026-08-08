const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const PAGE = { width: 595.28, height: 841.89, margin: 14 };
const WIDTH = PAGE.width - (PAGE.margin * 2);
const MODAL_LABELS = {
  '01': 'RODOVIÁRIO',
  '02': 'AÉREO',
  '03': 'AQUAVIÁRIO',
  '04': 'FERROVIÁRIO',
  '05': 'DUTOVIÁRIO',
  '06': 'MULTIMODAL'
};
const SERVICE_LABELS = {
  0: 'NORMAL',
  1: 'SUBCONTRATAÇÃO',
  2: 'REDESPACHO',
  3: 'REDESPACHO INTERMEDIÁRIO',
  4: 'SERVIÇO VINCULADO A MULTIMODAL'
};
const CTE_TYPE_LABELS = {
  0: 'CT-E NORMAL',
  1: 'CT-E DE COMPLEMENTO DE VALORES',
  2: 'CT-E DE ANULAÇÃO',
  3: 'CT-E SUBSTITUTO'
};
const TAKER_LABELS = {
  0: 'REMETENTE',
  1: 'EXPEDIDOR',
  2: 'RECEBEDOR',
  3: 'DESTINATÁRIO',
  4: 'OUTROS'
};

const decodeEntities = (value) => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const clean = (value, fallback = '-') => {
  const text = decodeEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
};

const cleanMultiline = (input) => {
  const text = decodeEntities(input)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text;
};

const escapeTag = (tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sectionPattern = (tag, flags = 'i') => new RegExp(
  `<(?:[\\w.-]+:)?${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escapeTag(tag)}\\s*>`,
  flags
);

const section = (xml, tag) => String(xml || '').match(sectionPattern(tag))?.[1] || '';

const sections = (xml, tag) => [...String(xml || '').matchAll(sectionPattern(tag, 'gi'))]
  .map((match) => match[1]);

const value = (xml, tag, fallback = '') => clean(section(xml, tag), fallback);

const openingTag = (xml, tag) => String(xml || '').match(new RegExp(
  `<(?:[\\w.-]+:)?${escapeTag(tag)}\\b([^>]*)>`,
  'i'
))?.[1] || '';

const attribute = (xml, tag, name) => {
  const attributes = openingTag(xml, tag);
  const match = attributes.match(new RegExp(`\\b${escapeTag(name)}=["']([^"']*)["']`, 'i'));
  return clean(match?.[1], '');
};

const digits = (input) => String(input || '').replace(/\D/g, '');

const formatCnpjCpf = (input) => {
  const number = digits(input);
  if (number.length === 14) {
    return number.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (number.length === 11) {
    return number.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return clean(input);
};

const formatCep = (input) => {
  const number = digits(input);
  return number.length === 8 ? number.replace(/^(\d{5})(\d{3})$/, '$1-$2') : clean(input);
};

const formatPhone = (input) => {
  const number = digits(input);
  if (number.length === 10) return number.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3');
  if (number.length === 11) return number.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  return clean(input);
};

const formatDateTime = (input) => {
  const match = String(input || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s)(\d{2}):(\d{2}):(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}:${match[6]}` : clean(input);
};

const formatDate = (input) => {
  const match = String(input || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : clean(input);
};

const numberText = (input, decimals = 2) => {
  const number = Number(String(input || '').replace(',', '.'));
  return Number.isFinite(number)
    ? new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(number)
    : clean(input);
};

const addressFrom = (partyXml, addressTag) => {
  const address = section(partyXml, addressTag);
  return {
    street: value(address, 'xLgr'),
    number: value(address, 'nro'),
    complement: value(address, 'xCpl', ''),
    district: value(address, 'xBairro'),
    city: value(address, 'xMun'),
    state: value(address, 'UF'),
    cep: formatCep(value(address, 'CEP', '')),
    country: value(address, 'xPais', 'BRASIL')
  };
};

const partyFrom = (xml, tag, addressTag) => {
  const party = section(xml, tag);
  if (!party) return null;
  return {
    name: value(party, 'xNome'),
    tradeName: value(party, 'xFant', ''),
    document: formatCnpjCpf(value(party, 'CNPJ', value(party, 'CPF', ''))),
    ie: value(party, 'IE'),
    phone: formatPhone(value(party, 'fone', '')),
    address: addressFrom(party, addressTag)
  };
};

const quantityFrom = (xml) => sections(xml, 'infQ').map((item) => ({
  measure: value(item, 'tpMed'),
  quantity: numberText(value(item, 'qCarga'), 4)
}));

const componentsFrom = (xml) => sections(xml, 'Comp').map((item) => ({
  name: value(item, 'xNome'),
  amount: numberText(value(item, 'vComp'))
}));

const continuousObservations = (compl) => {
  const result = {};
  const pattern = /<(?:[\w.-]+:)?ObsCont\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?ObsCont\s*>/gi;
  for (const match of String(compl || '').matchAll(pattern)) {
    const field = clean(match[1].match(/\bxCampo=["']([^"']*)["']/i)?.[1], '');
    if (field) result[field.toLowerCase()] = value(match[2], 'xTexto');
  }
  return result;
};

const takePartyFrom = (xml, ide, parties) => {
  const toma3 = section(ide, 'toma3');
  const toma4 = section(ide, 'toma4');
  const code = Number(value(toma3 || toma4, 'toma', '4'));
  const mapped = [parties.sender, parties.dispatcher, parties.receiver, parties.recipient][code];
  if (mapped) return { type: TAKER_LABELS[code], ...mapped };
  if (!toma4) return { type: TAKER_LABELS[code] || 'OUTROS' };
  return {
    type: 'OUTROS',
    name: value(toma4, 'xNome'),
    tradeName: '',
    document: formatCnpjCpf(value(toma4, 'CNPJ', value(toma4, 'CPF', ''))),
    ie: value(toma4, 'IE'),
    phone: formatPhone(value(toma4, 'fone', '')),
    address: addressFrom(toma4, 'enderToma')
  };
};

const taxFrom = (xml) => {
  const icms = section(section(xml, 'imp'), 'ICMS');
  const variants = ['ICMS00', 'ICMS20', 'ICMS45', 'ICMS60', 'ICMS90', 'ICMSOutraUF', 'ICMSSN'];
  const type = variants.find((tag) => section(icms, tag)) || '';
  const tax = type ? section(icms, type) : icms;
  return {
    situation: type === 'ICMSSN' ? 'SIMPLES NACIONAL' : (value(tax, 'CST', type || '-')),
    base: numberText(value(tax, 'vBC', '0')),
    rate: numberText(value(tax, 'pICMS', '0')),
    amount: numberText(value(tax, 'vICMS', '0')),
    reduction: numberText(value(tax, 'pRedBC', '0'))
  };
};

const documentsFrom = (xml) => {
  const result = [];
  sections(xml, 'infNFe').forEach((item) => result.push({
    type: 'NF-E',
    number: value(item, 'chave')
  }));
  sections(xml, 'infNF').forEach((item) => result.push({
    type: 'NF',
    number: [value(item, 'nDoc'), value(item, 'serie')].filter((item) => item !== '-').join('-'),
    value: numberText(value(item, 'vNF', ''))
  }));
  sections(xml, 'infOutros').forEach((item) => result.push({
    type: value(item, 'tpDoc', 'OUTRO'),
    number: value(item, 'nDoc'),
    value: numberText(value(item, 'vDocFisc', ''))
  }));
  return result;
};

const parseCteXml = (xml) => {
  const source = String(xml || '');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('XML de CT-e inseguro.');
  const infCte = section(source, 'infCte');
  if (!infCte) throw new Error('XML de CT-e inválido.');
  const ide = section(infCte, 'ide');
  const compl = section(infCte, 'compl');
  const normal = section(infCte, 'infCTeNorm');
  const cargo = section(normal, 'infCarga');
  const protocol = section(source, 'infProt');
  const observations = continuousObservations(compl);
  const parties = {
    issuer: partyFrom(infCte, 'emit', 'enderEmit'),
    sender: partyFrom(infCte, 'rem', 'enderReme'),
    recipient: partyFrom(infCte, 'dest', 'enderDest'),
    dispatcher: partyFrom(infCte, 'exped', 'enderExped'),
    receiver: partyFrom(infCte, 'receb', 'enderReceb')
  };
  parties.taker = takePartyFrom(infCte, ide, parties);
  const accessKey = digits(value(protocol, 'chCTe', attribute(source, 'infCte', 'Id'))).slice(-44);
  if (accessKey.length !== 44) throw new Error('Chave do CT-e ausente no XML.');

  const flow = section(compl, 'fluxo');
  const delivery = section(compl, 'Entrega');
  const modal = section(section(normal, 'infModal'), 'rodo');
  return {
    accessKey,
    model: value(ide, 'mod'),
    series: value(ide, 'serie'),
    number: value(ide, 'nCT'),
    issueDate: formatDateTime(value(ide, 'dhEmi')),
    cfop: value(ide, 'CFOP'),
    nature: value(ide, 'natOp'),
    modalCode: value(ide, 'modal'),
    modal: MODAL_LABELS[value(ide, 'modal')] || value(ide, 'modal'),
    serviceType: SERVICE_LABELS[Number(value(ide, 'tpServ', '0'))] || value(ide, 'tpServ'),
    cteType: CTE_TYPE_LABELS[Number(value(ide, 'tpCTe', '0'))] || value(ide, 'tpCTe'),
    globalized: value(ide, 'indGlobalizado', '0') === '1' ? 'SIM' : 'NÃO',
    origin: `${value(ide, 'xMunIni')} - ${value(ide, 'UFIni')}`,
    destination: `${value(ide, 'xMunFim')} - ${value(ide, 'UFFim')}`,
    operator: value(compl, 'xEmi'),
    expectedDelivery: formatDate(value(delivery, 'dProg', '')),
    observation: value(compl, 'xObs', ''),
    minute: observations.minuta || '',
    flow: {
      origin: value(flow, 'xOrig', ''),
      destination: value(flow, 'xDest', ''),
      route: value(flow, 'xRota', '')
    },
    parties,
    cargo: {
      predominantProduct: value(cargo, 'proPred'),
      otherCharacteristics: value(cargo, 'xOutCat', ''),
      totalValue: numberText(value(cargo, 'vCarga')),
      quantities: quantityFrom(cargo)
    },
    components: componentsFrom(section(infCte, 'vPrest')),
    totalService: numberText(value(section(infCte, 'vPrest'), 'vTPrest')),
    amountReceivable: numberText(value(section(infCte, 'vPrest'), 'vRec')),
    tax: taxFrom(infCte),
    documents: documentsFrom(normal),
    rntrc: value(modal, 'RNTRC'),
    protocol: value(protocol, 'nProt'),
    protocolDate: formatDateTime(value(protocol, 'dhRecbto')),
    authorizationStatus: value(protocol, 'xMotivo'),
    qrCode: value(section(source, 'infCTeSupl'), 'qrCodCTe', '')
  };
};

const box = (doc, x, y, width, height, lineWidth = 0.55) => {
  doc.save().lineWidth(lineWidth).strokeColor('#161616').rect(x, y, width, height).stroke().restore();
};

const write = (doc, text, x, y, options = {}) => {
  const {
    width = 100,
    height,
    size = 6.3,
    bold = false,
    align = 'left',
    color = '#111111',
    ellipsis = true
  } = options;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(size)
    .fillColor(color)
    .text(cleanMultiline(text), x, y, {
      width,
      height,
      align,
      ellipsis,
      lineGap: 0.3
    });
};

const cell = (doc, x, y, width, height, label, content, options = {}) => {
  box(doc, x, y, width, height);
  write(doc, label, x + 3, y + 2, {
    width: width - 6,
    height: 8,
    size: options.labelSize || 4.9,
    bold: true,
    color: '#333333'
  });
  write(doc, content, x + 3, y + (options.valueY || 10), {
    width: width - 6,
    height: height - (options.valueY || 10) - 2,
    size: options.size || 6.4,
    bold: options.bold,
    align: options.align || 'left',
    ellipsis: options.ellipsis !== false
  });
};

const partyLines = (party) => {
  if (!party) return '-';
  const address = party.address || {};
  return [
    party.name,
    [address.street, address.number, address.complement].filter((item) => item && item !== '-').join(', '),
    [address.district, address.city, address.state, address.cep].filter((item) => item && item !== '-').join(' - '),
    `CNPJ/CPF: ${party.document || '-'}   IE: ${party.ie || '-'}   FONE: ${party.phone || '-'}`
  ].filter(Boolean).join('\n');
};

const formattedAccessKey = (key) => digits(key).replace(/(\d{4})(?=\d)/g, '$1 ');

const makeBarcode = async (text, height = 10) => {
  try {
    return await bwipjs.toBuffer({
      bcid: 'code128',
      text: String(text || '0'),
      scale: 2,
      height,
      includetext: false,
      padding: 0
    });
  } catch {
    return null;
  }
};

const makeQrCode = async (text) => {
  if (!text) return null;
  try {
    return await bwipjs.toBuffer({
      bcid: 'qrcode',
      text,
      scale: 2,
      padding: 0,
      eclevel: 'M'
    });
  } catch {
    return null;
  }
};

const drawHeader = (doc, data, images) => {
  const x = PAGE.margin;
  const y = PAGE.margin;
  const left = 245;
  const middle = 118;
  const right = WIDTH - left - middle;
  box(doc, x, y, WIDTH, 91, 0.8);
  doc.moveTo(x + left, y).lineTo(x + left, y + 91).stroke();
  doc.moveTo(x + left + middle, y).lineTo(x + left + middle, y + 91).stroke();

  const logoPath = path.join(process.cwd(), 'assets', 'twtlogo.png');
  if (fs.existsSync(logoPath)) {
    try { doc.image(logoPath, x + 7, y + 7, { fit: [80, 27] }); } catch { /* texto abaixo identifica o emitente */ }
  }
  write(doc, data.parties.issuer?.name, x + 7, y + 36, {
    width: left - 14,
    height: 18,
    size: 8,
    bold: true
  });
  const issuer = data.parties.issuer;
  const address = issuer?.address || {};
  write(doc, [
    [address.street, address.number, address.district].filter((item) => item && item !== '-').join(', '),
    [address.city, address.state, address.cep].filter((item) => item && item !== '-').join(' - '),
    `CNPJ: ${issuer?.document || '-'}  IE: ${issuer?.ie || '-'}  FONE: ${issuer?.phone || '-'}`
  ].join('\n'), x + 7, y + 55, { width: left - 14, height: 32, size: 5.4 });

  write(doc, 'DACTE', x + left + 3, y + 5, { width: middle - 6, size: 13, bold: true, align: 'center' });
  write(doc, 'Documento Auxiliar do Conhecimento\nde Transporte Eletrônico', x + left + 5, y + 23, {
    width: middle - 10,
    height: 23,
    size: 6.2,
    align: 'center'
  });
  write(doc, data.modal, x + left + 5, y + 50, { width: middle - 10, size: 7.2, bold: true, align: 'center' });
  write(doc, `MD ${String(data.minute || '').replace(/^0+/, '') || '-'}`, x + left + 5, y + 67, {
    width: middle - 10,
    size: 7.2,
    bold: true,
    align: 'center'
  });

  const rx = x + left + middle;
  write(doc, `MODELO ${data.model}  SÉRIE ${data.series}`, rx + 4, y + 4, {
    width: right - 8,
    size: 5.5,
    align: 'center'
  });
  write(doc, `Nº ${data.number}`, rx + 4, y + 14, {
    width: right - 8,
    size: 12,
    bold: true,
    align: 'center'
  });
  write(doc, `FL 1/1  EMISSÃO ${data.issueDate}`, rx + 4, y + 30, {
    width: right - 8,
    size: 5.5,
    align: 'center'
  });
  if (images.accessKey) doc.image(images.accessKey, rx + 10, y + 42, { fit: [right - 72, 17] });
  if (images.qr) doc.image(images.qr, rx + right - 54, y + 37, { fit: [47, 47] });
  write(doc, formattedAccessKey(data.accessKey), rx + 5, y + 63, {
    width: right - 65,
    height: 16,
    size: 5,
    bold: true,
    align: 'center'
  });
  write(doc, `PROTOCOLO: ${data.protocol} - ${data.protocolDate}`, rx + 4, y + 81, {
    width: right - 65,
    size: 4.7,
    align: 'center'
  });
  return y + 91;
};

const drawDactePage = (doc, data, images) => {
  let y = drawHeader(doc, data, images);
  const x = PAGE.margin;

  cell(doc, x, y, WIDTH * .25, 23, 'TIPO DO CT-E', data.cteType, { size: 5.8, bold: true });
  cell(doc, x + WIDTH * .25, y, WIDTH * .25, 23, 'TIPO DO SERVIÇO', data.serviceType, { size: 5.8, bold: true });
  cell(doc, x + WIDTH * .5, y, WIDTH * .25, 23, 'TOMADOR DO SERVIÇO', data.parties.taker?.type, { size: 5.8, bold: true });
  cell(doc, x + WIDTH * .75, y, WIDTH * .25, 23, 'INDICADOR GLOBALIZADO', data.globalized, { size: 5.8, bold: true, align: 'center' });
  y += 23;

  cell(doc, x, y, WIDTH * .15, 26, 'CFOP', data.cfop, { size: 7.5, bold: true, align: 'center' });
  cell(doc, x + WIDTH * .15, y, WIDTH * .45, 26, 'NATUREZA DA PRESTAÇÃO', data.nature, { size: 5.8, bold: true });
  cell(doc, x + WIDTH * .6, y, WIDTH * .2, 26, 'INÍCIO DA PRESTAÇÃO', data.origin, { size: 6.1, bold: true });
  cell(doc, x + WIDTH * .8, y, WIDTH * .2, 26, 'TÉRMINO DA PRESTAÇÃO', data.destination, { size: 6.1, bold: true });
  y += 26;

  const half = WIDTH / 2;
  cell(doc, x, y, half, 50, 'REMETENTE', partyLines(data.parties.sender), { size: 5.35, valueY: 9 });
  cell(doc, x + half, y, half, 50, 'DESTINATÁRIO', partyLines(data.parties.recipient), { size: 5.35, valueY: 9 });
  y += 50;
  cell(doc, x, y, half, 50, 'EXPEDIDOR', partyLines(data.parties.dispatcher), { size: 5.35, valueY: 9 });
  cell(doc, x + half, y, half, 50, 'RECEBEDOR', partyLines(data.parties.receiver), { size: 5.35, valueY: 9 });
  y += 50;

  cell(doc, x, y, WIDTH, 48, `TOMADOR DO SERVIÇO: ${data.parties.taker?.type || '-'}`, partyLines(data.parties.taker), {
    size: 5.3,
    valueY: 9
  });
  y += 48;

  cell(doc, x, y, WIDTH * .35, 34, 'PRODUTO PREDOMINANTE', data.cargo.predominantProduct, { size: 7, bold: true });
  cell(doc, x + WIDTH * .35, y, WIDTH * .25, 34, 'OUTRAS CARACTERÍSTICAS DA CARGA', data.cargo.otherCharacteristics, { size: 5.9 });
  cell(doc, x + WIDTH * .6, y, WIDTH * .4, 34, 'VALOR TOTAL DA MERCADORIA', `R$ ${data.cargo.totalValue}`, { size: 8, bold: true, align: 'center' });
  y += 34;
  const quantities = data.cargo.quantities.slice(0, 6);
  const quantityWidth = WIDTH / Math.max(quantities.length, 1);
  if (!quantities.length) cell(doc, x, y, WIDTH, 27, 'INFORMAÇÕES DA CARGA', '-');
  quantities.forEach((quantity, index) => cell(
    doc,
    x + (quantityWidth * index),
    y,
    quantityWidth,
    27,
    quantity.measure,
    quantity.quantity,
    { size: 6.4, bold: true, align: 'center' }
  ));
  y += 27;

  const components = data.components.slice(0, 8);
  const componentWidth = WIDTH / Math.max(components.length + 2, 2);
  components.forEach((component, index) => cell(
    doc,
    x + (componentWidth * index),
    y,
    componentWidth,
    31,
    component.name,
    `R$ ${component.amount}`,
    { size: 5.9, bold: true, align: 'right' }
  ));
  const totalsX = x + (componentWidth * components.length);
  cell(doc, totalsX, y, componentWidth, 31, 'VALOR TOTAL DO SERVIÇO', `R$ ${data.totalService}`, { size: 6.2, bold: true, align: 'right' });
  cell(doc, totalsX + componentWidth, y, WIDTH - (componentWidth * (components.length + 1)), 31, 'VALOR A RECEBER', `R$ ${data.amountReceivable}`, { size: 6.2, bold: true, align: 'right' });
  y += 31;

  const taxWidth = WIDTH / 5;
  [
    ['SITUAÇÃO TRIBUTÁRIA', data.tax.situation],
    ['BASE DE CÁLCULO', `R$ ${data.tax.base}`],
    ['ALÍQUOTA ICMS', `${data.tax.rate}%`],
    ['VALOR ICMS', `R$ ${data.tax.amount}`],
    ['% RED. BC', `${data.tax.reduction}%`]
  ].forEach(([label, content], index) => cell(doc, x + taxWidth * index, y, taxWidth, 28, label, content, {
    size: 6,
    bold: true,
    align: 'center'
  }));
  y += 28;

  const documentText = data.documents.length
    ? data.documents.map((item) => `${item.type}: ${item.number}${item.value ? `  R$ ${item.value}` : ''}`).join('\n')
    : '-';
  cell(doc, x, y, WIDTH, 50, 'DOCUMENTOS ORIGINÁRIOS', documentText, { size: 5.5, valueY: 9 });
  y += 50;

  cell(doc, x, y, WIDTH * .35, 29, 'PREVISÃO DO FLUXO DA CARGA', [
    data.flow.origin,
    data.flow.destination,
    data.flow.route
  ].filter(Boolean).join(' > '), { size: 6, bold: true });
  cell(doc, x + WIDTH * .35, y, WIDTH * .25, 29, 'DATA PREVISTA DE ENTREGA', data.expectedDelivery, { size: 7, bold: true, align: 'center' });
  cell(doc, x + WIDTH * .6, y, WIDTH * .4, 29, 'EMISSOR', data.operator, { size: 6, bold: true });
  y += 29;

  cell(doc, x, y, WIDTH, 90, 'OBSERVAÇÕES', data.observation, {
    size: 5.7,
    valueY: 10,
    ellipsis: true
  });
  y += 90;

  cell(doc, x, y, WIDTH * .25, 27, 'RNTRC DA EMPRESA', data.rntrc, { size: 7, bold: true });
  cell(doc, x + WIDTH * .25, y, WIDTH * .25, 27, 'MODAL', data.modal, { size: 6.5, bold: true });
  cell(doc, x + WIDTH * .5, y, WIDTH * .5, 27, 'STATUS DA AUTORIZAÇÃO', data.authorizationStatus, { size: 6, bold: true });
  y += 27;

  box(doc, x, y, WIDTH, 95, 0.8);
  write(doc, 'DECLARO QUE RECEBI OS VOLUMES DESTE CONHECIMENTO EM PERFEITO ESTADO PELO QUE DOU POR CUMPRIDO O PRESENTE CONTRATO DE TRANSPORTE', x + 4, y + 3, {
    width: WIDTH - 8,
    height: 12,
    size: 5.3,
    bold: true,
    align: 'center'
  });
  doc.moveTo(x, y + 17).lineTo(x + WIDTH, y + 17).stroke();
  doc.moveTo(x + WIDTH * .23, y + 17).lineTo(x + WIDTH * .23, y + 95).stroke();
  doc.moveTo(x + WIDTH * .67, y + 17).lineTo(x + WIDTH * .67, y + 95).stroke();
  write(doc, 'DATA / HORA', x + 3, y + 20, { width: WIDTH * .23 - 6, size: 5, bold: true });
  write(doc, 'NOME / RG OU CPF / ASSINATURA DO RECEBEDOR', x + WIDTH * .23 + 3, y + 20, { width: WIDTH * .44 - 6, size: 5, bold: true });
  write(doc, `CT-E\n${data.number}-${data.series}`, x + WIDTH * .67 + 4, y + 21, { width: WIDTH * .33 - 8, height: 28, size: 10, bold: true, align: 'center' });
  if (images.bottomBarcode) {
    doc.image(images.bottomBarcode, x + WIDTH * .25, y + 49, { fit: [WIDTH * .4, 21] });
  }
  write(doc, formattedAccessKey(data.accessKey), x + WIDTH * .25, y + 72, { width: WIDTH * .4, size: 4.4, align: 'center' });
};

const buildDactePdf = async (models) => {
  const data = Array.isArray(models) ? models : [models];
  if (!data.length) throw new Error('Nenhum CT-e disponível para gerar o DACTE.');
  const prepared = await Promise.all(data.map(async (item) => ({
    data: item,
    images: {
      accessKey: await makeBarcode(item.accessKey, 8),
      bottomBarcode: await makeBarcode(item.accessKey, 12),
      qr: await makeQrCode(item.qrCode)
    }
  })));

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      autoFirstPage: false,
      size: 'A4',
      margin: 0,
      compress: true,
      info: {
        Title: data.length === 1 ? `DACTE ${data[0].number}` : `DACTEs da fatura (${data.length})`,
        Author: data[0]?.parties?.issuer?.name || 'TWT Airpack',
        Subject: 'Documento Auxiliar do Conhecimento de Transporte Eletrônico'
      }
    });
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    prepared.forEach(({ data: item, images }) => {
      doc.addPage({ size: 'A4', margin: 0 });
      drawDactePage(doc, item, images);
    });
    doc.end();
  });
};

module.exports = {
  parseCteXml,
  buildDactePdf,
  formatCnpjCpf,
  formatDateTime
};
