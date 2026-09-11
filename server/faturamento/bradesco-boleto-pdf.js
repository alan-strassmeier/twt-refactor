const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const PAGE = { width: 595.28, height: 841.89, margin: 24 };
const CONTENT_WIDTH = PAGE.width - (PAGE.margin * 2);

const safeText = (value, fallback = '-') => {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
};

const digits = (value) => String(value || '').replace(/\D/g, '');

const formatTaxId = (value) => {
  const normalized = digits(value);
  if (normalized.length === 14) {
    return normalized.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (normalized.length === 11) {
    return normalized.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return safeText(value);
};

const formatDate = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : safeText(value);
};

const formatMoney = (value) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL'
}).format(Number(value) || 0);

const formatDigitableLine = (value) => {
  const normalized = digits(value);
  if (normalized.length !== 47) return safeText(value);
  return [
    `${normalized.slice(0, 5)}.${normalized.slice(5, 10)}`,
    `${normalized.slice(10, 15)}.${normalized.slice(15, 21)}`,
    `${normalized.slice(21, 26)}.${normalized.slice(26, 32)}`,
    normalized.slice(32, 33),
    normalized.slice(33)
  ].join(' ');
};

const ourNumberDigit = (wallet, ourNumber) => {
  const value = `${digits(wallet).padStart(2, '0')}${digits(ourNumber).padStart(11, '0')}`;
  if (value.length !== 13) return '';
  let weight = 2;
  let sum = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    sum += Number(value[index]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const result = 11 - (sum % 11);
  if (result === 10) return 'P';
  if (result === 11) return '0';
  return String(result);
};

const formatOurNumber = (record) => {
  const wallet = digits(record.wallet).padStart(2, '0');
  const number = digits(record.ourNumber).padStart(11, '0');
  const digit = record.ourNumberDigit || ourNumberDigit(wallet, number);
  return `${wallet}/${number}${digit ? `-${digit}` : ''}`;
};

const formatBeneficiaryAccount = (record) => {
  const agency = digits(record.agency).padStart(4, '0');
  const account = digits(record.account).padStart(7, '0');
  if (agency.length !== 4 || account.length !== 7) return '-';
  const agencyDigit = safeText(record.agencyDigit, '');
  const accountDigit = safeText(record.accountDigit, '');
  return `${agency}${agencyDigit ? `-${agencyDigit}` : ''} / ${account}${accountDigit ? `-${accountDigit}` : ''}`;
};

const payerAddress = (payer = {}) => {
  const address = payer.address || {};
  const street = [address.street, address.number, address.complement]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .join(', ');
  const city = [address.city, address.state].filter(Boolean).join(' - ');
  const zip = digits(address.zip_code).replace(/^(\d{5})(\d{3})$/, '$1-$2');
  const locality = [address.district, city, zip].filter(Boolean).join(' | ');
  return [street, locality].filter(Boolean).join(' - ');
};

const drawField = (doc, x, y, width, height, label, value, options = {}) => {
  const displayValue = options.preserveLines
    ? String(value ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim()
    : safeText(value);
  doc.lineWidth(0.45).strokeColor('#1f2933').rect(x, y, width, height).stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#334e68')
    .text(label, x + 3, y + 2, { width: width - 6, height: 8, lineBreak: false });
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(options.fontSize || 8.5)
    .fillColor('#102a43')
    .text(displayValue || '-', x + 3, y + 12, {
      width: width - 6,
      height: Math.max(height - 14, 8),
      align: options.align || 'left',
      ellipsis: true,
      lineBreak: options.lineBreak !== false
    });
};

const drawBankHeader = (doc, y, digitableLine, receiptLabel) => {
  const x = PAGE.margin;
  const height = 30;
  doc.lineWidth(0.7).strokeColor('#102a43').rect(x, y, CONTENT_WIDTH, height).stroke();
  doc.save();
  doc.fillColor('#cc092f').rect(x + 1, y + 1, 82, height - 2).fill();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12)
    .text('bradesco', x + 5, y + 8, { width: 74, align: 'center' });
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#102a43')
    .text('237-2', x + 88, y + 8, { width: 48, align: 'center' });
  doc.moveTo(x + 142, y).lineTo(x + 142, y + height).stroke();
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(formatDigitableLine(digitableLine), x + 148, y + 6, {
      width: CONTENT_WIDTH - 156,
      align: 'right',
      lineBreak: false,
      ellipsis: true
    });
  doc.font('Helvetica').fontSize(5.5).fillColor('#486581')
    .text(receiptLabel, x + CONTENT_WIDTH - 145, y + 20, { width: 140, align: 'right' });
};

const drawCutLine = (doc, y) => {
  doc.save().dash(3, { space: 3 }).strokeColor('#829ab1')
    .moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).stroke().undash().restore();
  doc.font('Helvetica').fontSize(6).fillColor('#627d98')
    .text('Corte na linha pontilhada', PAGE.width - PAGE.margin - 110, y - 9, {
      width: 110,
      align: 'right'
    });
};

const drawCommonRows = (doc, y, record, compact = false) => {
  const x = PAGE.margin;
  const width = CONTENT_WIDTH;
  const row = compact ? 28 : 31;
  const amountWidth = 130;
  drawField(doc, x, y, width - amountWidth, row, 'Beneficiário',
    `${record.beneficiaryName} - CNPJ ${formatTaxId(record.beneficiaryTaxId)}`, { bold: true });
  drawField(doc, x + width - amountWidth, y, amountWidth, row, 'Agência / Código do beneficiário',
    formatBeneficiaryAccount(record), { bold: true, align: 'right' });
  y += row;

  const columns = [105, 91, 108, 105, width - 409];
  const labels = ['Data do documento', 'Nº do documento', 'Espécie doc.', 'Aceite', 'Data do processamento'];
  const values = [
    formatDate(record.issuedAt),
    `${record.invoiceId}-1`,
    record.speciesLabel || 'DS',
    record.acceptance || 'N',
    formatDate(record.createdAt || record.issuedAt)
  ];
  let cursor = x;
  columns.forEach((columnWidth, index) => {
    drawField(doc, cursor, y, columnWidth, row, labels[index], values[index], { bold: index === 1 });
    cursor += columnWidth;
  });
  y += row;

  const left = width - amountWidth;
  drawField(doc, x, y, 115, row, 'Carteira', digits(record.wallet).padStart(2, '0'), { bold: true });
  drawField(doc, x + 115, y, 165, row, 'Carteira / Nosso número', formatOurNumber(record), { bold: true });
  drawField(doc, x + 280, y, left - 280, row, 'Seu número', record.yourNumber || `FAT${record.invoiceId}`);
  drawField(doc, x + left, y, amountWidth, row, '(=) Valor do documento', formatMoney(record.amount), {
    bold: true,
    align: 'right'
  });
  return y + row;
};

const renderBradescoBankSlipPdf = async (record) => {
  const barCode = digits(record?.barCode);
  const digitableLine = digits(record?.digitableLine);
  if (barCode.length !== 44 || digitableLine.length !== 47) {
    throw Object.assign(new Error(
      'O boleto Bradesco não possui código de barras e linha digitável válidos.'
    ), { statusCode: 502, expose: true });
  }

  const barcodeImage = await bwipjs.toBuffer({
    bcid: 'interleaved2of5',
    text: barCode,
    scale: 2,
    height: 12,
    includetext: false,
    padding: 0
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      autoFirstPage: true,
      info: {
        Title: `Boleto Bradesco - Fatura ${safeText(record.invoiceId)}`,
        Author: safeText(record.beneficiaryName)
      }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const x = PAGE.margin;
    const width = CONTENT_WIDTH;
    const instructions = String(record.instructions || [
      `Referente a fatura ${record.invoiceId}.`,
      'Apos o vencimento multa de 3 por cento.',
      'Apos o vencimento juros de 0,15 por cento ao dia.'
    ].join('\n'));

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#102a43')
      .text('RECIBO DO PAGADOR', x, 19, { width, align: 'right' });
    drawBankHeader(doc, 29, record.digitableLine, 'Recibo do pagador');
    let y = drawCommonRows(doc, 59, record, true);
    drawField(doc, x, y, width - 130, 29, 'Pagador',
      `${record.payer?.name || '-'} - ${formatTaxId(record.payer?.tax_id)}`, { bold: true });
    drawField(doc, x + width - 130, y, 130, 29, 'Vencimento', formatDate(record.dueAt), {
      bold: true,
      align: 'right'
    });
    y += 29;
    drawField(doc, x, y, width, 31, 'Endereço do pagador', payerAddress(record.payer));
    y += 31;
    drawField(doc, x, y, width, 42, 'Instruções de responsabilidade do beneficiário', instructions, {
      fontSize: 7.3,
      preserveLines: true
    });
    y += 42;
    doc.font('Helvetica').fontSize(6.5).fillColor('#486581')
      .text('Autenticação mecânica', x, y + 5, { width, align: 'right' });

    drawCutLine(doc, 298);
    drawBankHeader(doc, 318, record.digitableLine, 'Ficha de compensação');
    y = drawCommonRows(doc, 348, record);
    const instructionWidth = width - 150;
    drawField(doc, x, y, instructionWidth, 98, 'Instruções (texto de responsabilidade do beneficiário)',
      instructions, { fontSize: 8, preserveLines: true });
    drawField(doc, x + instructionWidth, y, 150, 32, 'Vencimento', formatDate(record.dueAt), {
      bold: true,
      align: 'right'
    });
    drawField(doc, x + instructionWidth, y + 32, 150, 33, 'Carteira / Nosso número', formatOurNumber(record), {
      bold: true,
      align: 'right'
    });
    drawField(doc, x + instructionWidth, y + 65, 150, 33, '(=) Valor cobrado', formatMoney(record.amount), {
      bold: true,
      align: 'right'
    });
    y += 98;
    drawField(doc, x, y, width, 48, 'Pagador',
      `${record.payer?.name || '-'} - ${formatTaxId(record.payer?.tax_id)}\n${payerAddress(record.payer)}`, {
        bold: true,
        fontSize: 7.5,
        preserveLines: true
      });
    y += 48;
    drawField(doc, x, y, width, 26, 'Beneficiário final',
      `${record.beneficiaryName} - CNPJ ${formatTaxId(record.beneficiaryTaxId)}`);
    y += 34;
    doc.image(barcodeImage, x + 2, y, { fit: [365, 48], align: 'left', valign: 'top' });
    doc.font('Helvetica').fontSize(7).fillColor('#102a43')
      .text(barCode, x + 2, y + 51, { width: 365, align: 'center', characterSpacing: 0.4 });
    doc.font('Helvetica').fontSize(6.5).fillColor('#486581')
      .text('Autenticação mecânica / Ficha de compensação', x + 375, y + 18, {
        width: width - 375,
        align: 'right'
      });

    doc.end();
  });
};

module.exports = {
  formatTaxId,
  formatDate,
  formatMoney,
  formatDigitableLine,
  ourNumberDigit,
  formatOurNumber,
  formatBeneficiaryAccount,
  payerAddress,
  renderBradescoBankSlipPdf
};
