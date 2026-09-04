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

const formatBeneficiaryAccount = (value) => {
  const normalized = digits(value);
  if (normalized.length !== 12) return safeText(value);
  return `${normalized.slice(0, 4)} / ${normalized.slice(4, 11)}-${normalized.slice(11)}`;
};

const formatDigitableLine = (value) => {
  const normalized = digits(value);
  if (normalized.length === 47) {
    return [
      `${normalized.slice(0, 5)}.${normalized.slice(5, 10)}`,
      `${normalized.slice(10, 15)}.${normalized.slice(15, 21)}`,
      `${normalized.slice(21, 26)}.${normalized.slice(26, 32)}`,
      normalized.slice(32, 33),
      normalized.slice(33)
    ].join(' ');
  }
  if (normalized.length === 48) {
    return normalized.match(/.{12}/g).join(' ');
  }
  return safeText(value);
};

const payerAddress = (payer = {}) => {
  const address = payer.address || {};
  const street = [address.street, address.number, address.complement]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .join(', ');
  const city = [address.city, address.state].filter(Boolean).join(' - ');
  const locality = [address.district, city, digits(address.zip_code)]
    .filter(Boolean)
    .join(' | ');
  return [street, locality].filter(Boolean).join(' — ');
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
  doc.fillColor('#ec7000').rect(x + 1, y + 1, 64, height - 2).fill();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16)
    .text('ITAÚ', x + 9, y + 7, { width: 46, align: 'center' });
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#102a43')
    .text('341-7', x + 72, y + 8, { width: 48, align: 'center' });
  doc.moveTo(x + 126, y).lineTo(x + 126, y + height).stroke();
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(formatDigitableLine(digitableLine), x + 134, y + 6, {
      width: CONTENT_WIDTH - 142,
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
  const w = CONTENT_WIDTH;
  const row = compact ? 28 : 31;
  const amountWidth = 130;
  drawField(doc, x, y, w - amountWidth, row, 'Beneficiário',
    `${record.beneficiaryName} — CNPJ ${formatTaxId(record.beneficiaryTaxId)}`, { bold: true });
  drawField(doc, x + w - amountWidth, y, amountWidth, row, 'Agência / Conta beneficiária',
    formatBeneficiaryAccount(record.beneficiaryId), { bold: true, align: 'right' });
  y += row;

  const col = [105, 91, 108, 105, w - 409];
  const labels = ['Data do documento', 'Nº da fatura', 'Espécie doc.', 'Aceite', 'Data do processamento'];
  const values = [
    formatDate(record.issuedAt),
    `FATURA ${record.invoiceId}`,
    record.speciesLabel || 'DS',
    record.acceptance || 'N',
    formatDate(record.createdAt || record.issuedAt)
  ];
  let cursor = x;
  col.forEach((width, index) => {
    drawField(doc, cursor, y, width, row, labels[index], values[index], { bold: index === 1 });
    cursor += width;
  });
  y += row;

  const left = w - amountWidth;
  drawField(doc, x, y, 115, row, 'Carteira', record.wallet, { bold: true });
  drawField(doc, x + 115, y, 145, row, 'Nosso número', record.ourNumber, { bold: true });
  drawField(doc, x + 260, y, left - 260, row, 'Seu número', record.yourNumber || `FAT${record.invoiceId}`);
  drawField(doc, x + left, y, amountWidth, row, '(=) Valor do documento', formatMoney(record.amount), {
    bold: true,
    align: 'right'
  });
  return y + row;
};

const renderItauBankSlipPdf = async (record) => {
  const barCode = digits(record?.barCode);
  const digitableLine = digits(record?.digitableLine);
  if (barCode.length !== 44 || ![47, 48].includes(digitableLine.length)) {
    throw Object.assign(new Error('O boleto Itaú não possui código de barras e linha digitável válidos.'), {
      statusCode: 502,
      expose: true
    });
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
        Title: `Boleto Itaú - Fatura ${safeText(record.invoiceId)}`,
        Author: safeText(record.beneficiaryName)
      }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const x = PAGE.margin;
    const w = CONTENT_WIDTH;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#102a43')
      .text('RECIBO DO PAGADOR', x, 19, { width: w, align: 'right' });
    drawBankHeader(doc, 29, record.digitableLine, 'Recibo do pagador');
    let y = drawCommonRows(doc, 59, record, true);
    drawField(doc, x, y, w - 130, 29, 'Pagador',
      `${record.payer?.name || '-'} — ${formatTaxId(record.payer?.tax_id)}`, { bold: true });
    drawField(doc, x + w - 130, y, 130, 29, 'Vencimento', formatDate(record.dueAt), {
      bold: true,
      align: 'right'
    });
    y += 29;
    drawField(doc, x, y, w, 31, 'Endereço do pagador', payerAddress(record.payer));
    y += 31;
    drawField(doc, x, y, w, 34, 'Instruções de responsabilidade do beneficiário',
      safeText(record.instructions, 'Referente à fatura indicada. Não aceitar pagamento após a data limite.'), {
        fontSize: 7.5
      });
    y += 34;
    doc.font('Helvetica').fontSize(6.5).fillColor('#486581')
      .text('Autenticação mecânica', x, y + 5, { width: w, align: 'right' });

    drawCutLine(doc, 290);
    drawBankHeader(doc, 310, record.digitableLine, 'Ficha de compensação');
    y = drawCommonRows(doc, 340, record);
    const instructionWidth = w - 150;
    drawField(doc, x, y, instructionWidth, 89, 'Instruções (texto de responsabilidade do beneficiário)',
      safeText(record.instructions, 'Referente à fatura indicada. Não aceitar pagamento após a data limite.'), {
        fontSize: 8
      });
    drawField(doc, x + instructionWidth, y, 150, 30, 'Vencimento', formatDate(record.dueAt), {
      bold: true,
      align: 'right'
    });
    drawField(doc, x + instructionWidth, y + 30, 150, 29, 'Nosso número', record.ourNumber, {
      bold: true,
      align: 'right'
    });
    drawField(doc, x + instructionWidth, y + 59, 150, 30, '(=) Valor cobrado', formatMoney(record.amount), {
      bold: true,
      align: 'right'
    });
    y += 89;
    drawField(doc, x, y, w, 46, 'Pagador',
      `${record.payer?.name || '-'} — ${formatTaxId(record.payer?.tax_id)}\n${payerAddress(record.payer)}`, {
        bold: true,
        fontSize: 7.5,
        preserveLines: true
      });
    y += 46;
    drawField(doc, x, y, w, 26, 'Beneficiário final',
      `${record.beneficiaryName} — CNPJ ${formatTaxId(record.beneficiaryTaxId)}`);
    y += 34;
    doc.image(barcodeImage, x + 2, y, { fit: [365, 48], align: 'left', valign: 'top' });
    doc.font('Helvetica').fontSize(7).fillColor('#102a43')
      .text(barCode, x + 2, y + 51, { width: 365, align: 'center', characterSpacing: 0.4 });
    doc.font('Helvetica').fontSize(6.5).fillColor('#486581')
      .text('Autenticação mecânica / Ficha de compensação', x + 375, y + 18, {
        width: w - 375,
        align: 'right'
      });

    doc.end();
  });
};

module.exports = {
  formatTaxId,
  formatDate,
  formatMoney,
  formatBeneficiaryAccount,
  formatDigitableLine,
  payerAddress,
  renderItauBankSlipPdf
};
