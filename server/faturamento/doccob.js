const digits = (value) => String(value || '').replace(/\D/g, '');

const cleanField = (value) => String(value ?? '').trim();

const normalizedIntegerText = (value) => {
  const normalized = digits(value).replace(/^0+(?=\d)/, '');
  return normalized || '';
};

const parseDate = (value) => {
  const normalized = digits(value);
  if (normalized.length !== 8) return null;
  const day = normalized.slice(0, 2);
  const month = normalized.slice(2, 4);
  const year = normalized.slice(4);
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso
    ? iso
    : null;
};

const parseDecimal = (value) => {
  const text = cleanField(value);
  if (!text) return null;
  const normalized = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

const parseImpliedHundred = (value) => {
  const normalized = normalizedIntegerText(value);
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) ? number / 100 : null;
};

const accessKeyCheckDigit = (body) => {
  let sum = 0;
  let weight = 2;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const digit = 11 - (sum % 11);
  return digit === 10 || digit === 11 ? 0 : digit;
};

const isValidCteAccessKey = (value) => {
  const normalized = digits(value);
  return normalized.length === 44 &&
    accessKeyCheckDigit(normalized.slice(0, 43)) === Number(normalized[43]);
};

const splitRecords = (content) => String(content || '')
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .map((line) => line.split('~').map(cleanField))
  .filter((fields) => fields.some(Boolean));

const invoiceFromFinancialRecord = (fields) => ({
  id: normalizedIntegerText(fields[5]),
  issuedAt: parseDate(fields[11] || fields[6]),
  dueAt: parseDate(fields[12]),
  clientCnpj: digits(fields[7]),
  issuerCnpj: digits(fields[1]),
  total: parseDecimal(fields[13])
});

const invoiceFromFreightRecord = (fields) => ({
  id: normalizedIntegerText(fields[6]),
  issuedAt: parseDate(fields[8]),
  dueAt: null,
  clientCnpj: digits(fields[18]),
  issuerCnpj: digits(fields[12]),
  total: parseDecimal(fields[26])
});

const transportFromFreightRecord = (fields) => {
  const reference = normalizedIntegerText(fields[6]);
  const suffix = normalizedIntegerText(fields[7]);
  const rawAccessKey = digits(fields[69]);
  const accessKey = isValidCteAccessKey(rawAccessKey) ? rawAccessKey : null;
  return {
    reference,
    minuteHint: accessKey ? null : reference,
    cteNumber: accessKey
      ? [reference, suffix || '0'].filter(Boolean).join('-')
      : null,
    accessKey,
    issuedAt: parseDate(fields[8]),
    clientCnpj: digits(fields[18]),
    issuerCnpj: digits(fields[12]),
    freight: parseDecimal(fields[26]),
    taxedWeight: parseDecimal(fields[57]),
    volumes: parseImpliedHundred(fields[53]),
    status: cleanField(fields[70]) || null,
    notes: []
  };
};

const invoiceLinkFromRecord = (fields) => ({
  invoiceId: normalizedIntegerText(fields[6]),
  invoiceIssuedAt: parseDate(fields[7]),
  clientCnpj: digits(fields[8]),
  reference: normalizedIntegerText(fields[12]),
  transportIssuedAt: parseDate(fields[13])
});

const noteFromRecord = (fields) => ({
  reference: normalizedIntegerText(fields[6]),
  transportIssuedAt: parseDate(fields[7]),
  partyCnpj: digits(fields[8]),
  series: normalizedIntegerText(fields[11]),
  number: normalizedIntegerText(fields[12]),
  issuedAt: parseDate(fields[13])
});

const sameTransport = (transport, link) =>
  transport.reference === link.reference &&
  (!transport.issuedAt || !link.transportIssuedAt || transport.issuedAt === link.transportIssuedAt);

const findTransportForLink = (transports, link) =>
  transports.find((transport) => sameTransport(transport, link)) ||
  transports.find((transport) => transport.reference === link.reference);

const parseDoccob = (content, expectedInvoiceId = null) => {
  const records = splitRecords(content);
  const expected = expectedInvoiceId === null
    ? null
    : normalizedIntegerText(expectedInvoiceId);
  const financialRecords = records
    .filter((fields) => fields[0] === '4')
    .map(invoiceFromFinancialRecord)
    .filter((invoice) => invoice.id);
  const freightInvoices = records
    .filter((fields) => fields[0] === '1' && fields[1] === 'FREIGHT' && fields[2] === 'FATURA')
    .map(invoiceFromFreightRecord)
    .filter((invoice) => invoice.id);
  const invoice = (expected
    ? financialRecords.find((item) => item.id === expected) ||
      freightInvoices.find((item) => item.id === expected)
    : financialRecords[0] || freightInvoices[0]) || null;

  if (!invoice) {
    return { version: null, generatedAt: null, invoice: null, transports: [] };
  }

  const versionRecord = records.find((fields) => fields[0] === '0');
  const transports = records
    .filter((fields) => fields[0] === '1' && fields[1] === 'FREIGHT' && fields[2] === 'CTE')
    .map(transportFromFreightRecord)
    .filter((transport) => transport.reference);
  const links = records
    .filter((fields) => fields[0] === '3' && fields[1] === 'FT_CTR')
    .map(invoiceLinkFromRecord)
    .filter((link) => link.invoiceId === invoice.id);
  const notes = records
    .filter((fields) => fields[0] === '3' && fields[1] === 'CTR_NF')
    .map(noteFromRecord)
    .filter((note) => note.reference && note.number);

  const linkedTransports = (links.length ? links : transports.map((transport) => ({
    invoiceId: invoice.id,
    clientCnpj: invoice.clientCnpj,
    reference: transport.reference,
    transportIssuedAt: transport.issuedAt
  }))).map((link) => {
    const source = findTransportForLink(transports, link);
    const transport = source
      ? { ...source }
      : {
        reference: link.reference,
        minuteHint: link.reference,
        cteNumber: null,
        accessKey: null,
        issuedAt: link.transportIssuedAt,
        clientCnpj: link.clientCnpj,
        issuerCnpj: invoice.issuerCnpj,
        freight: null,
        taxedWeight: null,
        volumes: null,
        status: null,
        notes: []
      };
    transport.notes = notes.filter((note) =>
      note.reference === link.reference &&
      (!note.transportIssuedAt || !link.transportIssuedAt ||
        note.transportIssuedAt === link.transportIssuedAt));
    return transport;
  });

  return {
    version: cleanField(versionRecord?.[2]) || null,
    generatedAt: cleanField(versionRecord?.[1]) || null,
    invoice,
    transports: linkedTransports
  };
};

module.exports = {
  parseDate,
  parseDecimal,
  isValidCteAccessKey,
  splitRecords,
  parseDoccob
};
