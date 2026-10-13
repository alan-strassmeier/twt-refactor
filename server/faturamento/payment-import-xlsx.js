const { inflateRawSync } = require('node:zlib');
const { DOMParser } = require('@xmldom/xmldom');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 96;
const MAX_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
const MAX_ROWS = 2000;

const invalidFile = (message) => Object.assign(new Error(message), { statusCode: 422 });

const decodeBase64File = (value) => {
  const encoded = String(value || '').trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw invalidFile('O arquivo XLSX não foi enviado corretamente.');
  }
  const file = Buffer.from(encoded, 'base64');
  if (!file.length || file.length > MAX_FILE_BYTES) {
    throw invalidFile('O arquivo XLSX deve ter no máximo 2 MB.');
  }
  if (file.length < 4 || file.readUInt32LE(0) !== 0x04034b50) {
    throw invalidFile('O arquivo enviado não é um XLSX válido.');
  }
  return file;
};

const findEndOfCentralDirectory = (archive) => {
  const minimum = Math.max(0, archive.length - 65557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw invalidFile('A estrutura compactada do XLSX é inválida.');
};

const unzipEntries = (archive) => {
  const end = findEndOfCentralDirectory(archive);
  const totalEntries = archive.readUInt16LE(end + 10);
  const centralOffset = archive.readUInt32LE(end + 16);
  if (!totalEntries || totalEntries > MAX_ARCHIVE_ENTRIES) {
    throw invalidFile('O XLSX possui uma quantidade de arquivos internos não permitida.');
  }

  const entries = new Map();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw invalidFile('O diretório interno do XLSX é inválido.');
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
      .replace(/\\/g, '/').replace(/^\/+/, '');
    offset = nameStart + nameLength + extraLength + commentLength;

    if ((flags & 1) !== 0 || ![0, 8].includes(method) || name.includes('../')) {
      throw invalidFile('O XLSX contém um item interno não permitido.');
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw invalidFile('O conteúdo descompactado do XLSX excede o limite permitido.');
    }
    if (name.endsWith('/') || !name) continue;
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw invalidFile('O XLSX contém um item interno inválido.');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) throw invalidFile('O XLSX está incompleto.');
    let data;
    try {
      data = method === 8
        ? inflateRawSync(compressed, { maxOutputLength: uncompressedSize + 1 })
        : Buffer.from(compressed);
    } catch {
      throw invalidFile('O XLSX possui um item interno corrompido ou excessivamente grande.');
    }
    if (data.length !== uncompressedSize) throw invalidFile('O XLSX possui um item interno corrompido.');
    entries.set(name, data);
  }
  return entries;
};

const parseXml = (value, label) => {
  const errors = [];
  const document = new DOMParser({
    onError(level, message) {
      if (level === 'error' || level === 'fatalError') errors.push(message);
    }
  }).parseFromString(Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''), 'text/xml');
  if (!document?.documentElement || errors.length || document.getElementsByTagName('parsererror').length) {
    throw invalidFile(`O XML interno ${label} do XLSX é inválido.`);
  }
  return document;
};

const nodeText = (node) => String(node?.textContent || '');
const elements = (node, localName) => {
  const direct = node?.getElementsByTagName(localName);
  if (direct?.length) return Array.from(direct);
  return Array.from(node?.getElementsByTagNameNS?.('*', localName) || []);
};

const sharedStringsFrom = (entries) => {
  const source = entries.get('xl/sharedStrings.xml');
  if (!source) return [];
  const document = parseXml(source, 'sharedStrings.xml');
  return elements(document, 'si').map((item) => elements(item, 't').map(nodeText).join(''));
};

const dateStyleIndexesFrom = (entries) => {
  const source = entries.get('xl/styles.xml');
  if (!source) return new Set();
  const document = parseXml(source, 'styles.xml');
  const customDates = new Set(elements(document, 'numFmt')
    .filter((item) => /[dmy]/i.test(item.getAttribute('formatCode') || ''))
    .map((item) => Number(item.getAttribute('numFmtId'))));
  const builtInDates = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  const cellXfs = elements(document, 'cellXfs')[0];
  return new Set(elements(cellXfs, 'xf').map((item, index) => ({
    index,
    id: Number(item.getAttribute('numFmtId'))
  })).filter(({ id }) => builtInDates.has(id) || customDates.has(id)).map(({ index }) => index));
};

const firstWorksheetPath = (entries) => {
  const workbookSource = entries.get('xl/workbook.xml');
  const relationshipsSource = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbookSource || !relationshipsSource) {
    if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
    throw invalidFile('O XLSX não contém uma planilha legível.');
  }
  const workbook = parseXml(workbookSource, 'workbook.xml');
  const firstSheet = elements(workbook, 'sheet')[0];
  const relationId = firstSheet?.getAttribute('r:id') || firstSheet?.getAttribute('id');
  const relationships = parseXml(relationshipsSource, 'workbook.xml.rels');
  const relation = elements(relationships, 'Relationship')
    .find((item) => item.getAttribute('Id') === relationId);
  const target = String(relation?.getAttribute('Target') || '').replace(/\\/g, '/');
  if (!target || target.includes('../')) throw invalidFile('A primeira planilha do XLSX é inválida.');
  if (target.startsWith('/')) return target.slice(1);
  const normalized = target.replace(/^\.\//, '');
  return normalized.startsWith('xl/') ? normalized : `xl/${normalized}`;
};

const excelDate = (serial) => {
  const number = Number(serial);
  if (!Number.isFinite(number) || number < 1 || number > 2958465) return '';
  const milliseconds = Math.round((number - 25569) * 86400000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const cellColumn = (reference) => {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
};

const cellValue = (cell, sharedStrings, dateStyles) => {
  const type = cell.getAttribute('t') || '';
  const style = Number(cell.getAttribute('s'));
  if (type === 'inlineStr') return elements(cell, 't').map(nodeText).join('');
  const raw = nodeText(elements(cell, 'v')[0]);
  if (type === 's') return sharedStrings[Number(raw)] ?? '';
  if (type === 'b') return raw === '1';
  if (dateStyles.has(style)) return excelDate(raw);
  if (type === 'str' || type === 'e') return raw;
  if (raw === '') return '';
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
};

const normalizeHeader = (value) => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const headerAliases = Object.freeze({
  supplierTaxId: ['n id fiscal 1', 'id fiscal', 'cnpj'],
  supplierName: ['nome 1', 'nome'],
  vendor: ['fornecedor'],
  reference: ['referencia', 'referencia 1'],
  paymentDate: ['vencim em', 'vencimento'],
  amount: ['montante em mi', 'montante', 'valor pago']
});

const spreadsheetDate = (value) => {
  if (typeof value === 'number') return excelDate(value);
  const text = String(value || '').trim();
  if (!text) return '';
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const brazilian = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  const normalized = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : brazilian
      ? `${brazilian[3]}-${brazilian[2].padStart(2, '0')}-${brazilian[1].padStart(2, '0')}`
      : '';
  if (!normalized) return '';
  const date = new Date(`${normalized}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === normalized
    ? normalized
    : '';
};

const parseReference = (value) => {
  const text = String(value ?? '').trim();
  if (!/^\d{1,20}(?:-\d{1,6})?$/.test(text)) return null;
  const base = text.split('-')[0].replace(/^0+(?=\d)/, '');
  return { source: text, cteNumber: base };
};

const parseAmount = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  const number = Number(normalized.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : null;
};

const parsePaymentWorksheet = (source, sharedStrings = [], dateStyles = new Set()) => {
  const document = parseXml(source, 'da planilha');
  const xmlRows = elements(document, 'row');
  if (xmlRows.length < 2) throw invalidFile('A planilha não possui pagamentos para analisar.');
  if (xmlRows.length - 1 > MAX_ROWS) throw invalidFile(`A planilha deve ter no máximo ${MAX_ROWS} pagamentos.`);
  const values = xmlRows.map((row) => {
    const cells = [];
    elements(row, 'c').forEach((cell) => {
      const column = cellColumn(cell.getAttribute('r'));
      if (column >= 0 && column < 100) cells[column] = cellValue(cell, sharedStrings, dateStyles);
    });
    return { number: Number(row.getAttribute('r')) || 0, cells };
  });
  const headerRow = values.find((row) => row.cells.some((cell) => normalizeHeader(cell) === 'referencia'));
  if (!headerRow) throw invalidFile('Não foi encontrada a coluna “Referência” no XLSX.');
  const columns = {};
  Object.entries(headerAliases).forEach(([key, aliases]) => {
    columns[key] = headerRow.cells.findIndex((value) => aliases.includes(normalizeHeader(value)));
  });
  for (const key of ['reference', 'paymentDate', 'amount']) {
    const label = key === 'reference' ? 'Referência' : key === 'paymentDate' ? 'Vencimento' : 'Montante em MI';
    if (columns[key] < 0) throw invalidFile(`A coluna obrigatória “${label}” não foi encontrada.`);
  }

  const rows = [];
  const errors = [];
  values.filter((row) => row.number > headerRow.number).forEach((row) => {
    if (!row.cells.some((value) => String(value ?? '').trim())) return;
    const reference = parseReference(row.cells[columns.reference]);
    const amount = parseAmount(row.cells[columns.amount]);
    if (!reference || amount === null || amount <= 0) {
      errors.push({
        row: row.number,
        reference: String(row.cells[columns.reference] ?? ''),
        message: !reference ? 'Referência de CT-e inválida.' : 'Valor pago inválido.'
      });
      return;
    }
    const paymentDate = spreadsheetDate(row.cells[columns.paymentDate]);
    if (!paymentDate) {
      errors.push({
        row: row.number,
        reference: reference.source,
        message: 'Data de pagamento inválida na coluna Vencimento.'
      });
      return;
    }
    rows.push({
      row: row.number,
      supplierTaxId: String(columns.supplierTaxId >= 0 ? row.cells[columns.supplierTaxId] ?? '' : '').replace(/\D/g, ''),
      supplierName: String(columns.supplierName >= 0 ? row.cells[columns.supplierName] ?? '' : '').trim(),
      vendor: String(columns.vendor >= 0 ? row.cells[columns.vendor] ?? '' : '').trim(),
      reference: reference.source,
      cteNumber: reference.cteNumber,
      paymentDate,
      amount: Math.round(amount * 100) / 100
    });
  });
  if (!rows.length) throw invalidFile('Nenhum pagamento válido foi encontrado no XLSX.');
  return { rows, errors };
};

const parsePaymentXlsx = (base64) => {
  const entries = unzipEntries(decodeBase64File(base64));
  if ([...entries.keys()].some((name) => /vbaProject\.bin$/i.test(name))) {
    throw invalidFile('Planilhas com macros não são aceitas. Envie um arquivo .xlsx sem macros.');
  }
  const worksheetPath = firstWorksheetPath(entries);
  const worksheet = entries.get(worksheetPath);
  if (!worksheet) throw invalidFile('A primeira planilha do XLSX não foi encontrada.');
  return parsePaymentWorksheet(worksheet, sharedStringsFrom(entries), dateStyleIndexesFrom(entries));
};

module.exports = {
  MAX_FILE_BYTES,
  decodeBase64File,
  unzipEntries,
  excelDate,
  parseReference,
  parseAmount,
  spreadsheetDate,
  parsePaymentWorksheet,
  parsePaymentXlsx
};
