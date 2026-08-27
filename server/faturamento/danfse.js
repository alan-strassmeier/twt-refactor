const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const { DOMParser } = require('@xmldom/xmldom');

const PAGE = { width: 595.28, height: 841.89, margin: 14 };
const WIDTH = PAGE.width - (PAGE.margin * 2);

const clean = (value, fallback = '-') => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim() || fallback;
const digits = (value) => String(value || '').replace(/\D/g, '');

const elements = (parent, name) => Array.from(parent?.getElementsByTagName?.('*') || [])
  .filter((item) => item.localName === name);
const first = (parent, name) => elements(parent, name)[0] || null;
const text = (parent, name, fallback = '-') => clean(first(parent, name)?.textContent, fallback);

const formatCnpj = (value) => {
  const number = digits(value);
  return number.length === 14
    ? number.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : clean(value);
};
const formatCep = (value) => {
  const number = digits(value);
  return number.length === 8 ? number.replace(/^(\d{5})(\d{3})$/, '$1-$2') : clean(value);
};
const formatDate = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : clean(value);
};
const formatDateTime = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}:${match[6]}` : clean(value);
};
const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(number)
    : '-';
};

const parseAddress = (parent) => {
  const address = first(parent, 'end') || first(parent, 'enderNac');
  return {
    street: text(address, 'xLgr'),
    number: text(address, 'nro'),
    complement: text(address, 'xCpl', ''),
    district: text(address, 'xBairro'),
    municipalityCode: text(address, 'cMun'),
    state: text(address, 'UF'),
    zipCode: text(address, 'CEP')
  };
};

const addressLine = (address) => [
  address.street,
  address.number,
  address.complement,
  address.district
].filter((value) => value && value !== '-').join(', ') || '-';

const consultationUrlFor = (accessKey, environment) => {
  const baseUrl = environment === 'production'
    ? 'https://www.nfse.gov.br/ConsultaPublica'
    : 'https://www.producaorestrita.nfse.gov.br/ConsultaPublica';
  return `${baseUrl}?tpc=1&chave=${encodeURIComponent(accessKey)}`;
};

const parseNfseXml = (xml) => {
  const document = new DOMParser().parseFromString(String(xml || ''), 'application/xml');
  const root = document.documentElement;
  if (root?.localName !== 'NFSe') throw new Error('XML de NFS-e inválido para gerar o DANFSe.');
  const info = first(root, 'infNFSe');
  const dpsInfo = first(root, 'infDPS');
  const issuer = first(info, 'emit');
  const client = first(dpsInfo, 'toma');
  const service = first(dpsInfo, 'serv');
  const serviceValues = first(dpsInfo, 'valores');
  const issuerAddress = parseAddress(issuer);
  const clientAddress = parseAddress(client);
  const accessKey = digits(String(info?.getAttribute('Id') || '').replace(/^NFS/i, ''));
  if (accessKey.length !== 50) throw new Error('Chave de acesso inválida no XML da NFS-e.');
  const environmentType = text(dpsInfo, 'tpAmb', '');
  if (!['1', '2'].includes(environmentType)) {
    throw new Error('Tipo de ambiente inválido no XML da NFS-e.');
  }
  const environment = environmentType === '1' ? 'production' : 'homologation';
  return {
    accessKey,
    environment,
    environmentType,
    consultationUrl: consultationUrlFor(accessKey, environment),
    nfseNumber: text(info, 'nNFSe'),
    competence: formatDate(text(dpsInfo, 'dCompet')),
    processedAt: formatDateTime(text(info, 'dhProc')),
    dpsNumber: text(dpsInfo, 'nDPS'),
    dpsSeries: text(dpsInfo, 'serie'),
    emissionAt: formatDateTime(text(dpsInfo, 'dhEmi')),
    emissionCity: text(info, 'xLocEmi'),
    serviceCity: text(info, 'xLocPrestacao'),
    incidenceCity: text(info, 'xLocIncid'),
    issuer: {
      document: formatCnpj(text(issuer, 'CNPJ')),
      name: text(issuer, 'xNome'),
      phone: text(issuer, 'fone'),
      email: text(issuer, 'email'),
      address: issuerAddress
    },
    client: {
      document: formatCnpj(text(client, 'CNPJ')),
      name: text(client, 'xNome'),
      phone: text(client, 'fone'),
      email: text(client, 'email'),
      address: clientAddress
    },
    service: {
      code: text(service, 'cTribNac'),
      label: text(info, 'xTribNac'),
      nbsCode: text(service, 'cNBS'),
      nbsLabel: text(info, 'xNBS'),
      description: text(service, 'xDescServ')
    },
    taxation: {
      issqn: text(serviceValues, 'tribISSQN') === '1' ? 'Operação tributável' : text(serviceValues, 'tribISSQN'),
      issRetention: text(serviceValues, 'tpRetISSQN') === '1' ? 'Não retido' : text(serviceValues, 'tpRetISSQN'),
      pisCofinsCst: text(serviceValues, 'CST'),
      totalTaxPercentage: text(serviceValues, 'pTotTribSN')
    },
    amount: Number(text(serviceValues, 'vServ', '0')),
    netAmount: Number(text(info, 'vLiq', text(serviceValues, 'vServ', '0')))
  };
};

const line = (doc, x1, y1, x2, y2, width = 0.55) => doc.save()
  .lineWidth(width)
  .strokeColor('#222222')
  .moveTo(x1, y1)
  .lineTo(x2, y2)
  .stroke()
  .restore();

const box = (doc, x, y, width, height, options = {}) => {
  if (options.fill) doc.save().fillColor(options.fill).rect(x, y, width, height).fill().restore();
  doc.save().lineWidth(0.55).strokeColor('#222222').rect(x, y, width, height).stroke().restore();
};

const fitText = (doc, value, width, preferred = 7.4, minimum = 5.5) => {
  let size = preferred;
  while (size > minimum && doc.widthOfString(clean(value)) > width) size -= 0.2;
  return size;
};

const labelValue = (doc, x, y, width, label, value, options = {}) => {
  doc.font('Helvetica-Bold').fontSize(options.labelSize || 6.2).fillColor('#111111')
    .text(label, x, y, { width, lineBreak: false });
  const valueY = y + (options.gap || 8);
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(fitText(doc, value, width, options.valueSize || 7.4, options.minimum || 5.4))
    .text(clean(value), x, valueY, {
      width,
      height: options.height || 20,
      ellipsis: true,
      lineGap: 1
    });
};

const sectionTitle = (doc, y, title) => {
  doc.save().fillColor('#eeeeee').rect(PAGE.margin, y, WIDTH, 16).fill().restore();
  line(doc, PAGE.margin, y, PAGE.margin + WIDTH, y);
  line(doc, PAGE.margin, y + 16, PAGE.margin + WIDTH, y + 16);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#111111')
    .text(title, PAGE.margin + 4, y + 4, { width: WIDTH - 8 });
  return y + 16;
};

const buildDanfsePdf = async (xml) => {
  const data = parseNfseXml(xml);
  const qr = await bwipjs.toBuffer({
    bcid: 'qrcode',
    text: data.consultationUrl,
    scale: 3,
    padding: 0
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: [PAGE.width, PAGE.height],
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      info: {
        Title: `DANFSe ${data.nfseNumber}`,
        Author: data.issuer.name,
        Subject: data.environment === 'production'
          ? 'Documento Auxiliar da NFS-e'
          : 'DANFSe de homologação - sem valor fiscal'
      }
    });
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    let y = PAGE.margin;
    box(doc, PAGE.margin, y, WIDTH, PAGE.height - (PAGE.margin * 2));
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#237b58').text('NFS-e', PAGE.margin + 8, y + 12, {
      width: 110
    });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text('DANFSe v2.0', PAGE.margin + 170, y + 12, {
      width: 220,
      align: 'center'
    });
    doc.font('Helvetica-Bold').fontSize(9).text('Documento Auxiliar da NFS-e', PAGE.margin + 170, y + 28, {
      width: 220,
      align: 'center'
    });
    if (data.environment !== 'production') {
      doc.font('Helvetica-Bold').fontSize(6.8).fillColor('#b42318')
        .text('HOMOLOGAÇÃO - SEM VALOR FISCAL', PAGE.margin + 170, y + 42, {
          width: 220,
          align: 'center'
        });
    }
    const environmentHeader = data.environment === 'production'
      ? `Município: ${data.emissionCity} - RS\nAmbiente: Produção`
      : `Município: ${data.emissionCity} - RS\nProdução Restrita\nSEM VALOR FISCAL`;
    doc.font(data.environment === 'production' ? 'Helvetica' : 'Helvetica-Bold')
      .fontSize(7)
      .fillColor(data.environment === 'production' ? '#111111' : '#b42318')
      .text(environmentHeader, PAGE.margin + 430, y + 8, {
      width: 125,
      lineGap: 1.4
      });
    doc.fillColor('#111111');
    y += 52;
    line(doc, PAGE.margin, y, PAGE.margin + WIDTH, y);

    labelValue(doc, PAGE.margin + 4, y + 5, 420, 'CHAVE DE ACESSO DA NFS-e', data.accessKey, {
      bold: true,
      valueSize: 8
    });
    doc.image(qr, PAGE.margin + WIDTH - 92, y + 5, { width: 78, height: 78 });
    labelValue(doc, PAGE.margin + 4, y + 34, 135, 'NÚMERO DA NFS-e', data.nfseNumber, { bold: true });
    labelValue(doc, PAGE.margin + 145, y + 34, 145, 'COMPETÊNCIA DA NFS-e', data.competence);
    labelValue(doc, PAGE.margin + 296, y + 34, 180, 'DATA E HORA DA EMISSÃO', data.processedAt);
    labelValue(doc, PAGE.margin + 4, y + 61, 135, 'NÚMERO DA DPS', data.dpsNumber);
    labelValue(doc, PAGE.margin + 145, y + 61, 145, 'SÉRIE DA DPS', data.dpsSeries);
    labelValue(doc, PAGE.margin + 296, y + 61, 180, 'EMISSÃO DA DPS', data.emissionAt);
    y += 92;

    y = sectionTitle(doc, y, 'PRESTADOR / FORNECEDOR');
    labelValue(doc, PAGE.margin + 4, y + 5, 175, 'CNPJ', data.issuer.document);
    labelValue(doc, PAGE.margin + 185, y + 5, 270, 'NOME EMPRESARIAL', data.issuer.name, { bold: true });
    labelValue(doc, PAGE.margin + 461, y + 5, 100, 'TELEFONE', data.issuer.phone);
    labelValue(doc, PAGE.margin + 4, y + 32, 330, 'ENDEREÇO', addressLine(data.issuer.address));
    labelValue(doc, PAGE.margin + 340, y + 32, 120, 'MUNICÍPIO / UF', `${data.emissionCity} / ${data.issuer.address.state}`);
    labelValue(doc, PAGE.margin + 466, y + 32, 95, 'CEP', formatCep(data.issuer.address.zipCode));
    labelValue(doc, PAGE.margin + 4, y + 59, 330, 'E-MAIL', data.issuer.email);
    labelValue(doc, PAGE.margin + 340, y + 59, 221, 'REGIME', 'Simples Nacional - ME/EPP');
    y += 86;

    y = sectionTitle(doc, y, 'TOMADOR / ADQUIRENTE');
    labelValue(doc, PAGE.margin + 4, y + 5, 175, 'CNPJ', data.client.document);
    labelValue(doc, PAGE.margin + 185, y + 5, 376, 'NOME EMPRESARIAL', data.client.name, { bold: true });
    labelValue(doc, PAGE.margin + 4, y + 32, 360, 'ENDEREÇO', addressLine(data.client.address));
    labelValue(doc, PAGE.margin + 370, y + 32, 105, 'CÓDIGO IBGE', data.client.address.municipalityCode);
    labelValue(doc, PAGE.margin + 481, y + 32, 80, 'CEP', formatCep(data.client.address.zipCode));
    y += 59;

    y = sectionTitle(doc, y, 'SERVIÇO PRESTADO');
    labelValue(doc, PAGE.margin + 4, y + 5, 160, 'CÓDIGO DE TRIBUTAÇÃO', data.service.code);
    labelValue(doc, PAGE.margin + 170, y + 5, 150, 'CÓDIGO NBS', data.service.nbsCode);
    labelValue(doc, PAGE.margin + 326, y + 5, 235, 'LOCAL DA PRESTAÇÃO', `${data.serviceCity} / RS`);
    labelValue(doc, PAGE.margin + 4, y + 32, 557, 'SERVIÇO', data.service.label, { bold: true });
    labelValue(doc, PAGE.margin + 4, y + 59, 557, 'DESCRIÇÃO DO SERVIÇO', data.service.description, {
      height: 28,
      valueSize: 7.6
    });
    y += 94;

    y = sectionTitle(doc, y, 'TRIBUTAÇÃO');
    labelValue(doc, PAGE.margin + 4, y + 5, 175, 'ISSQN', data.taxation.issqn);
    labelValue(doc, PAGE.margin + 185, y + 5, 175, 'RETENÇÃO DO ISSQN', data.taxation.issRetention);
    labelValue(doc, PAGE.margin + 366, y + 5, 95, 'CST PIS/COFINS', data.taxation.pisCofinsCst);
    labelValue(doc, PAGE.margin + 467, y + 5, 94, 'TRIBUTOS APROX.', `${data.taxation.totalTaxPercentage}%`);
    labelValue(doc, PAGE.margin + 4, y + 32, 300, 'MUNICÍPIO DE INCIDÊNCIA', `${data.incidenceCity} / RS`);
    labelValue(doc, PAGE.margin + 310, y + 32, 251, 'IBS / CBS', 'Sem valor destacado');
    y += 59;

    y = sectionTitle(doc, y, 'VALOR TOTAL DA NFS-e');
    labelValue(doc, PAGE.margin + 4, y + 6, 180, 'VALOR DA OPERAÇÃO / SERVIÇO', money(data.amount), {
      bold: true,
      valueSize: 11
    });
    labelValue(doc, PAGE.margin + 190, y + 6, 180, 'TOTAL DAS RETENÇÕES', '-');
    labelValue(doc, PAGE.margin + 376, y + 6, 185, 'VALOR LÍQUIDO DA NFS-e', money(data.netAmount), {
      bold: true,
      valueSize: 11
    });
    y += 44;
    line(doc, PAGE.margin, y, PAGE.margin + WIDTH, y);
    doc.font('Helvetica-Bold').fontSize(7).text('INFORMAÇÕES COMPLEMENTARES', PAGE.margin + 4, y + 5);
    doc.font('Helvetica').fontSize(7).text(
      `Totais aproximados dos tributos conforme Lei nº 12.741/2012: ${data.taxation.totalTaxPercentage}% (Simples Nacional).`,
      PAGE.margin + 4,
      y + 19,
      { width: WIDTH - 8 }
    );

    const footerY = PAGE.height - PAGE.margin - 35;
    line(doc, PAGE.margin, footerY, PAGE.margin + WIDTH, footerY);
    labelValue(doc, PAGE.margin + 4, footerY + 4, 160, 'DATA DA CIENTIFICAÇÃO', '');
    labelValue(doc, PAGE.margin + 170, footerY + 4, 165, 'IDENTIFICAÇÃO E ASSINATURA', '');
    labelValue(doc, PAGE.margin + 341, footerY + 4, 220, 'Nº NFS-e / CHAVE NFS-e', `${data.nfseNumber} / ${data.accessKey}`, {
      valueSize: 5.8,
      minimum: 4.7
    });
    doc.end();
  });
};

module.exports = {
  parseNfseXml,
  consultationUrlFor,
  formatCnpj,
  formatCep,
  formatDate,
  formatDateTime,
  buildDanfsePdf
};
