const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const {
  authenticatedGet,
  invoiceListFromPayload,
  normalizeInvoice
} = require('./brudam');
const { findDoccobForInvoice } = require('./r2-doccob');

const COMPANY = {
  name: 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA',
  address: 'AV SERTORIO, 4455',
  district: 'JARDIM SAO PEDRO',
  city: 'PORTO ALEGRE',
  state: 'RS',
  cep: '91040-621',
  document: '97.434.690/0001-29',
  phone: '(51) 3342-4425',
  stateRegistration: '0963199668'
};
const MAX_LINKED_DOCUMENTS = 100;
const DETAIL_CONCURRENCY = 6;
const DOCCOB_DETAIL_CONCURRENCY = 4;
const PAGE = { width: 595.28, height: 841.89, margin: 14 };
const CONTENT_WIDTH = PAGE.width - (PAGE.margin * 2);
const legalTextFor = (companyName) => [
  'Reconheço (emos) a exatidão desta fatura de PRESTAÇÃO DE SERVIÇOS, na importância acima pagarei (emos)',
  `à ${safeText(companyName, COMPANY.name)}, ou à sua ordem, na Praça e vencimento indicados.`,
  'Na falta de pagamento no vencimento serão cobrados juros legais e atualização conforme indicadores fixados pelo Governo.'
].join(' ');

const firstValue = (object, keys) => {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
};

const numberValue = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.includes(',')
    ? value.replace(/\./g, '').replace(',', '.')
    : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const safeText = (value, fallback = '-') => {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || fallback;
};

const digits = (value) => String(value || '').replace(/\D/g, '');

const formatCnpj = (value) => {
  const normalized = digits(value);
  return normalized.length === 14
    ? normalized.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : safeText(value);
};

const formatCep = (value) => {
  const normalized = digits(value);
  return normalized.length === 8
    ? normalized.replace(/^(\d{5})(\d{3})$/, '$1-$2')
    : safeText(value);
};

const formatDate = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const brazilian = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return brazilian ? brazilian[0] : safeText(value);
};

const formatNumber = (value, decimals = 2) => {
  const number = numberValue(value);
  return number === null
    ? '-'
    : new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(number);
};

const exactInvoiceRecord = (invoices, invoiceId) => invoices.find((invoice) => {
  const publicId = firstValue(invoice, ['fatura', 'numero']);
  return String(publicId ?? invoice?.id ?? '') === String(invoiceId);
});

const companyFromPayload = (payload, cnpj) => {
  const expected = digits(cnpj);
  if (!payload || Number(payload.status) !== 1 || !Array.isArray(payload.data)) return null;
  return payload.data.find((company) => digits(company?.cnpj) === expected) || null;
};

const normalizedCompany = (company, fallback = {}) => {
  const street = firstValue(company, ['endereco', 'logradouro', 'xLgr']) || '';
  const number = firstValue(company, ['numero', 'nro']) || '';
  const complement = firstValue(company, ['complemento', 'xCpl']) || '';
  const address = [street, number, complement].filter(Boolean).join(', ') || fallback.address || '';
  const district = firstValue(company, ['bairro', 'xBairro']) || fallback.district || '';
  const city = firstValue(company, ['cidade', 'municipio', 'xMun']) || fallback.city || '';
  const state = firstValue(company, ['uf', 'UF', 'estado']) || fallback.state || '';
  const cep = firstValue(company, ['cep', 'CEP']) || fallback.cep || '';

  return {
    name: safeText(
      firstValue(company, ['razao', 'razao_social', 'xNome', 'fantasia', 'xFant']) ||
      fallback.name
    ),
    tradeName: safeText(firstValue(company, ['fantasia', 'xFant']) || fallback.tradeName || '', ''),
    document: firstValue(company, ['cnpj', 'cpf_cnpj', 'nDoc']) || fallback.document || '',
    stateRegistration: firstValue(company, ['ie', 'inscricao_estadual', 'IE']) ||
      fallback.stateRegistration || '',
    phone: firstValue(company, ['telefone', 'fone', 'nFone']) || fallback.phone || '',
    address: safeText(address, ''),
    district: safeText(district, ''),
    city: safeText(city, ''),
    state: safeText(state, ''),
    cep: cep ? formatCep(cep) : ''
  };
};

const linkedDocumentsFromInvoice = (invoice) =>
  (Array.isArray(invoice?.documentos) ? invoice.documentos : [])
    .filter((document) => document && typeof document === 'object')
    .slice(0, MAX_LINKED_DOCUMENTS);

const linkedDocumentsFromDoccob = (doccob) =>
  (Array.isArray(doccob?.transports) ? doccob.transports : [])
    .slice(0, MAX_LINKED_DOCUMENTS)
    .map((transport) => ({
      chave: transport.accessKey,
      id_minuta: transport.minuteHint,
      numero: transport.cteNumber,
      tipo: transport.accessKey ? 'CTE' : 'MINUTA',
      valor: transport.freight,
      doccob: transport
    }));

const minuteDataFromPayload = (payload) => {
  if (!payload || Number(payload.status) !== 1 || !Array.isArray(payload.data)) return null;
  return payload.data.find((item) => item && typeof item === 'object') || null;
};

const detailIdentifiers = (document) => {
  const values = [
    document?.chave,
    document?.chave_cte,
    document?.id_minuta,
    document?.minuta_id,
    typeof document?.minuta === 'object' ? null : document?.minuta,
    document?.doccob?.minuteHint
  ];
  return [...new Set(values
    .map((value) => String(value ?? '').trim())
    // `id` e `numero` genéricos não são documentados como identificadores de minuta.
    .filter((value) => value && value.length <= 64))];
};

const fetchMinuteDetail = async (document, get = authenticatedGet) => {
  for (const identifier of detailIdentifiers(document)) {
    try {
      const result = await get(
        `/operacional/consulta/minuta/${encodeURIComponent(identifier)}`
      );
      const detail = result.response.ok ? minuteDataFromPayload(result.payload) : null;
      if (detail) return detail;
    } catch {
      // Tenta o próximo identificador documentado para o mesmo vínculo.
    }
  }
  return null;
};

const normalizedLookupText = (value) => String(value || '')
  .trim()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase();

const comparableNumber = (value) => {
  const normalized = digits(value).replace(/^0+(?=\d)/, '');
  return normalized || '';
};

const occurrenceEventsFromPayload = (payload) => {
  if (!payload || Number(payload.status) !== 1 || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((item) => Array.isArray(item?.dados) ? item.dados : []);
};

const occurrenceMinuteIdentifiers = (payload) => {
  const identifiers = [];
  occurrenceEventsFromPayload(payload).forEach((event) => {
    [event?.minuta, event?.id_minuta, event?.minuta_id, event?.numero_minuta]
      .forEach((value) => {
        const identifier = comparableNumber(value);
        if (identifier) identifiers.push(identifier);
      });
    if (normalizedLookupText(event?.tipo).includes('MINUTA')) {
      const identifier = comparableNumber(event?.numero);
      if (identifier) identifiers.push(identifier);
    }
    [event?.chave, event?.chave_cte, event?.cte_chave].forEach((value) => {
      const identifier = digits(value);
      if (identifier.length === 44) identifiers.push(identifier);
    });
  });
  return [...new Set(identifiers)];
};

const occurrenceCteNumbers = (payload) => [...new Set(
  occurrenceEventsFromPayload(payload)
    .flatMap((event) => [event?.cte_numero, event?.numero_cte, event?.xDocCTe])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
)];

const minuteIdsFromCostsPayload = (payload) => {
  if (!payload || Number(payload.status) !== 1 || !Array.isArray(payload.data)) return [];
  return [...new Set(payload.data
    .map((item) => comparableNumber(item?.id))
    .filter(Boolean))];
};

const minuteDetailMatchesNote = (detail, note) => {
  if (!detail || !note) return false;
  const expectedNumber = comparableNumber(note.number);
  const expectedCnpj = digits(note.partyCnpj);
  const documentNumbers = (Array.isArray(detail.documentos) ? detail.documentos : [])
    .flatMap((document) => [document?.nDoc, document?.numero, document?.numero_nf])
    .map(comparableNumber)
    .filter(Boolean);
  if (documentNumbers.length && expectedNumber && !documentNumbers.includes(expectedNumber)) {
    return false;
  }
  const partyDocuments = [detail.rem, detail.dest, detail.toma, detail.exped, detail.receb]
    .flatMap((party) => [party?.nDoc, party?.cnpj, party?.documento])
    .map(digits)
    .filter((document) => document.length === 14);
  return !(partyDocuments.length && expectedCnpj.length === 14 &&
    !partyDocuments.includes(expectedCnpj));
};

const minuteIdentity = (detail) => comparableNumber(
  detail?.minuta?.id || detail?.minuta?.codigo || detail?.id_minuta
);

const fetchMinuteDetailsForNote = async (note, get = authenticatedGet) => {
  const document = digits(note?.partyCnpj);
  const number = comparableNumber(note?.number);
  if (document.length !== 14 || !number) return [];
  const query = new URLSearchParams({ documento: document, numero: number });
  const occurrenceResult = await get(`/tracking/ocorrencias/cnpj/nf?${query}`);
  if (!occurrenceResult.response.ok || Number(occurrenceResult.payload?.status) !== 1) return [];

  const identifiers = occurrenceMinuteIdentifiers(occurrenceResult.payload);
  for (const cteNumber of occurrenceCteNumbers(occurrenceResult.payload)) {
    try {
      const costsQuery = new URLSearchParams({ numero: cteNumber, limit: '10' });
      const costsResult = await get(`/operacional/custos?${costsQuery}`);
      if (costsResult.response.ok) {
        identifiers.push(...minuteIdsFromCostsPayload(costsResult.payload));
      }
    } catch {
      // A própria ocorrência ainda pode ter fornecido a minuta ou a chave do CT-e.
    }
  }

  const uniqueIdentifiers = [...new Set(identifiers)];
  const details = [];
  for (const identifier of uniqueIdentifiers) {
    try {
      const detail = await fetchMinuteDetail({ id_minuta: identifier }, get);
      if (detail && minuteDetailMatchesNote(detail, note)) details.push(detail);
    } catch {
      // Um candidato inválido não deve impedir a validação dos demais.
    }
  }
  const byMinute = new Map();
  details.forEach((detail) => {
    const identity = minuteIdentity(detail);
    if (identity) byMinute.set(identity, detail);
  });
  return [...byMinute.values()];
};

const resolveDoccobTransportDetail = async (transport, get = authenticatedGet) => {
  const primaryDocument = {
    chave: transport?.accessKey,
    id_minuta: transport?.minuteHint
  };
  const primary = await fetchMinuteDetail(primaryDocument, get);
  if (primary) return primary;

  const matches = new Map();
  for (const note of transport?.notes || []) {
    const details = await fetchMinuteDetailsForNote(note, get);
    details.forEach((detail) => {
      const identity = minuteIdentity(detail);
      if (identity) matches.set(identity, detail);
    });
  }
  return matches.size === 1 ? matches.values().next().value : null;
};

const fetchCompany = async (cnpj) => {
  const normalized = digits(cnpj);
  if (normalized.length !== 14) return null;
  const result = await authenticatedGet(
    `/cadastro/empresas?${new URLSearchParams({ cnpj: normalized })}`
  );
  return result.response.ok ? companyFromPayload(result.payload, normalized) : null;
};

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
};

const sumDocumentValues = (documents, key) => documents.reduce((total, document) =>
  total + (numberValue(document?.[key]) || 0), 0);

const shipmentFromDetail = (linkedDocument, detail, parties = {}) => {
  const transport = linkedDocument?.doccob || null;
  const doccobNotes = Array.isArray(transport?.notes) ? transport.notes : [];
  const doccobNoteNumbers = doccobNotes
    .map((note) => note.number)
    .filter(Boolean)
    .join(', ');
  if (!detail) {
    const type = safeText(firstValue(linkedDocument, ['tipo', 'tpDoc']), '');
    return {
      minute: safeText(
        transport?.minuteHint ||
        (type.toLowerCase().includes('minuta')
          ? firstValue(linkedDocument, ['id_minuta', 'minuta', 'numero', 'id'])
          : null)
      ),
      cte: safeText(
        transport?.cteNumber ||
        (type.toLowerCase().includes('cte')
          ? firstValue(linkedDocument, ['numero'])
          : null)
      ),
      collection: '-',
      date: formatDate(transport?.issuedAt),
      note: safeText(doccobNoteNumbers),
      noteValue: null,
      authorization: '-',
      origin: '-',
      destination: '-',
      destinationState: '-',
      taxedWeight: numberValue(transport?.taxedWeight),
      volumes: numberValue(transport?.volumes),
      freight: numberValue(transport?.freight) ?? numberValue(linkedDocument?.valor),
      observation: '',
      service: type || 'Não informado'
    };
  }

  const minute = detail.minuta || {};
  const cargo = minute.carga || {};
  const documents = Array.isArray(detail.documentos) ? detail.documentos : [];
  const noteNumbers = documents
    .map((document) => firstValue(document, ['nDoc', 'numero']))
    .filter(Boolean)
    .join(', ') || doccobNoteNumbers;
  const origin = normalizedCompany(parties.origin || detail.rem, {
    name: firstValue(detail.rem, ['xFant', 'xNome'])
  });
  const destination = normalizedCompany(parties.destination || detail.dest, {
    name: firstValue(detail.dest, ['xFant', 'xNome'])
  });
  const originLocation = [origin.city, origin.state].filter(Boolean).join(', ');
  const destinationLocation = [destination.city, destination.state].filter(Boolean).join(', ');
  const grossWeight = numberValue(cargo.pBru);
  const cubedWeight = numberValue(cargo.pCub);

  return {
    minute: safeText(
      firstValue(minute, ['id']) ||
      transport?.minuteHint ||
      firstValue(linkedDocument, ['id_minuta', 'id'])
    ),
    cte: safeText(
      firstValue(minute, ['xDocCTe', 'numero_cte']) ||
      transport?.cteNumber ||
      (String(linkedDocument?.tipo || '').toLowerCase().includes('cte')
        ? firstValue(linkedDocument, ['numero'])
        : null)
    ),
    collection: safeText(firstValue(minute, ['coleta', 'id_coleta', 'cColeta'])),
    date: formatDate(
      firstValue(minute, ['dEmi']) ||
      firstValue(documents[0], ['dEmi']) ||
      transport?.issuedAt
    ),
    note: safeText(noteNumbers),
    noteValue: documents.length ? sumDocumentValues(documents, 'vNF') : null,
    authorization: safeText(firstValue(minute, ['cAut', 'nAver'])),
    origin: safeText([
      origin.tradeName || origin.name,
      originLocation
    ].filter(Boolean).join('\n')),
    destination: safeText([
      destination.tradeName || destination.name,
      destinationLocation
    ].filter(Boolean).join('\n')),
    destinationState: destination.state || '-',
    taxedWeight: grossWeight === null && cubedWeight === null
      ? numberValue(transport?.taxedWeight)
      : Math.max(grossWeight || 0, cubedWeight || 0),
    volumes: numberValue(firstValue(cargo, ['qVol'])) ??
      (documents.length ? sumDocumentValues(documents, 'qVol') : numberValue(transport?.volumes)),
    freight: numberValue(detail?.valores?.vFrete) ??
      numberValue(transport?.freight) ??
      numberValue(linkedDocument?.valor),
    observation: safeText(detail?.compl?.xObs, ''),
    service: safeText(firstValue(minute, ['xServico', 'servico', 'cServ']))
  };
};

const requestExactInvoice = async (invoiceId) => {
  const queries = [
    new URLSearchParams({ 'id[eq]': String(invoiceId), limit: '100', skip: '0' }),
    new URLSearchParams({ id: String(invoiceId), limit: '100', skip: '0' })
  ];
  let lastResult = null;
  for (const query of queries) {
    const result = await authenticatedGet(`/financeiro/faturas?${query}`);
    lastResult = result;
    const invoices = invoiceListFromPayload(result.payload);
    const invoice = Array.isArray(invoices) ? exactInvoiceRecord(invoices, invoiceId) : null;
    if (result.response.ok && Number(result.payload?.status) === 1 && invoice) {
      return { invoice, payload: result.payload };
    }
  }

  const upstreamStatus = Number(lastResult?.response?.status);
  throw Object.assign(new Error('Fatura não encontrada na Brudam.'), {
    statusCode: upstreamStatus >= 500 ? 502 : 404
  });
};

const fetchInvoicePdfData = async (invoiceId) => {
  if (!/^\d{1,20}$/.test(String(invoiceId || '')) || Number(invoiceId) < 1) {
    throw Object.assign(new Error('Número da fatura inválido.'), { statusCode: 422 });
  }

  const { invoice } = await requestExactInvoice(invoiceId);
  const normalizedInvoice = normalizeInvoice(invoice);
  const clientDocument = digits(normalizedInvoice.clientDocument);
  let clientRecord = null;
  try {
    clientRecord = await fetchCompany(clientDocument);
  } catch {
    // O PDF ainda pode ser gerado com os dados resumidos da fatura.
  }
  const client = normalizedCompany(clientRecord, {
    name: normalizedInvoice.client,
    document: clientDocument
  });
  let doccob = null;
  try {
    doccob = await findDoccobForInvoice({
      invoiceId: normalizedInvoice.id || invoiceId,
      clientCnpj: clientDocument
    });
  } catch (error) {
    console.warn('[faturamento:doccob]', {
      invoiceId,
      clientCnpj: clientDocument,
      error: error.message
    });
  }

  const issuerDocument = digits(doccob?.invoice?.issuerCnpj || COMPANY.document);
  let issuerRecord = null;
  try {
    issuerRecord = await fetchCompany(issuerDocument);
  } catch {
    // Mantém os dados conhecidos da transportadora se o cadastro estiver indisponível.
  }
  const issuer = normalizedCompany(issuerRecord, {
    ...COMPANY,
    document: issuerDocument || COMPANY.document
  });

  const doccobDocuments = linkedDocumentsFromDoccob(doccob);
  const linkedDocuments = doccobDocuments.length
    ? doccobDocuments
    : linkedDocumentsFromInvoice(invoice);
  const details = await mapWithConcurrency(
    linkedDocuments,
    doccobDocuments.length ? DOCCOB_DETAIL_CONCURRENCY : DETAIL_CONCURRENCY,
    doccobDocuments.length
      ? (document) => resolveDoccobTransportDetail(document.doccob)
      : fetchMinuteDetail
  );

  const partyDocuments = [...new Set(details.flatMap((detail) => [
    digits(detail?.rem?.nDoc),
    digits(detail?.dest?.nDoc)
  ]).filter((document) => document.length === 14))];
  const partyRecords = new Map();
  await mapWithConcurrency(partyDocuments, DETAIL_CONCURRENCY, async (document) => {
    try {
      partyRecords.set(document, await fetchCompany(document));
    } catch {
      partyRecords.set(document, null);
    }
  });

  const shipments = linkedDocuments.map((document, index) =>
    shipmentFromDetail(document, details[index], {
      origin: partyRecords.get(digits(details[index]?.rem?.nDoc)),
      destination: partyRecords.get(digits(details[index]?.dest?.nDoc))
    })
  );

  return {
    invoice: {
      id: normalizedInvoice.id,
      issuedAt: normalizedInvoice.issuedAt || doccob?.invoice?.issuedAt,
      dueAt: normalizedInvoice.dueAt || doccob?.invoice?.dueAt,
      total: normalizedInvoice.total ?? doccob?.invoice?.total,
      surcharge: numberValue(firstValue(invoice, ['acrescimo', 'valor_acrescimo', 'vAcre'])) || 0,
      discount: numberValue(firstValue(invoice, ['desconto', 'valor_desconto', 'vDesc'])) || 0,
      nfs: safeText(firstValue(invoice, ['nfs', 'numero_nfs']), '')
    },
    client,
    issuer,
    shipments,
    detailAvailable: shipments.some((shipment) => shipment.minute !== '-' || shipment.cte !== '-'),
    source: doccobDocuments.length ? 'doccob' : 'brudam'
  };
};

const drawBox = (doc, x, y, width, height, options = {}) => {
  doc.save()
    .lineWidth(options.lineWidth || 0.65)
    .strokeColor(options.stroke || '#111111')
    .rect(x, y, width, height)
    .stroke()
    .restore();
};

const drawCellText = (doc, text, x, y, width, options = {}) => {
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(options.size || 6.5)
    .fillColor(options.color || '#111111')
    .text(safeText(text), x + (options.padding ?? 3), y + (options.topPadding ?? 3), {
      width: Math.max(1, width - ((options.padding ?? 3) * 2)),
      height: options.height,
      align: options.align || 'left',
      ellipsis: options.ellipsis !== false,
      lineGap: options.lineGap || 0
    });
};

const drawLogo = (doc) => {
  const logoPath = path.join(process.cwd(), 'assets', 'twtlogo.png');
  try {
    const logo = fs.readFileSync(logoPath);
    doc.image(logo, 27, 17, { fit: [95, 42], align: 'center', valign: 'center' });
  } catch {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#12394f').text('TWT AIRPACK', 24, 28);
  }
};

const drawInvoiceHeader = (doc, data, barcode) => {
  const issuer = data.issuer || normalizedCompany(null, COMPANY);
  const issuerCityLine = [
    issuer.district,
    [issuer.city, issuer.state].filter(Boolean).join('-'),
    issuer.cep ? `CEP: ${issuer.cep}` : ''
  ].filter(Boolean).join(', ');
  const x = PAGE.margin;
  const y = 12;
  const h = 60;
  const companyWidth = 340;
  const titleWidth = 112;
  const numberWidth = CONTENT_WIDTH - companyWidth - titleWidth;
  drawBox(doc, x, y, CONTENT_WIDTH, h);
  doc.moveTo(x + companyWidth, y).lineTo(x + companyWidth, y + h).stroke();
  doc.moveTo(x + companyWidth + titleWidth, y).lineTo(x + companyWidth + titleWidth, y + h).stroke();
  drawLogo(doc);
  doc.font('Helvetica-Bold').fontSize(6.7).fillColor('#111111')
    .text(issuer.name, 130, 18, { width: 205 });
  doc.font('Helvetica').fontSize(5.3)
    .text(issuer.address, 130, 30, { width: 205 })
    .text(issuerCityLine, 130, 40, { width: 205 })
    .text(`CNPJ: ${formatCnpj(issuer.document)}`, 130, 50, { width: 130 })
    .text(`Fone: ${safeText(issuer.phone)}`, 130, 60, { width: 110 })
    .text(`IE: ${safeText(issuer.stateRegistration)}`, 240, 60, { width: 95 });
  doc.font('Helvetica-Bold').fontSize(17)
    .text('Fatura', x + companyWidth, y + 20, { width: titleWidth, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(16)
    .text(safeText(data.invoice.id), x + companyWidth + titleWidth, y + 8, {
      width: numberWidth,
      align: 'center'
    });
  if (barcode) {
    doc.image(barcode, x + companyWidth + titleWidth + 7, y + 30, {
      fit: [numberWidth - 14, 24],
      align: 'center'
    });
  }
};

const clientAddressLines = (client) => {
  const location = [
    client.district,
    [client.city, client.state].filter(Boolean).join('-'),
    client.cep ? `CEP: ${client.cep}` : ''
  ].filter(Boolean).join(', ');
  return [
    client.name,
    client.address,
    location,
    [
      client.document ? `CNPJ: ${formatCnpj(client.document)}` : '',
      client.phone ? `Fone: ${client.phone}` : ''
    ].filter(Boolean).join('     ')
  ].filter(Boolean);
};

const drawClientBlock = (doc, data) => {
  const x = PAGE.margin;
  const y = 76;
  const h = 62;
  const clientWidth = 340;
  const valueWidth = (CONTENT_WIDTH - clientWidth) / 2;
  drawBox(doc, x, y, CONTENT_WIDTH, h);
  doc.moveTo(x + clientWidth, y).lineTo(x + clientWidth, y + h).stroke();
  doc.moveTo(x + clientWidth + valueWidth, y).lineTo(x + clientWidth + valueWidth, y + h).stroke();
  doc.moveTo(x + clientWidth, y + 20).lineTo(x + CONTENT_WIDTH, y + 20).stroke();
  doc.moveTo(x + clientWidth, y + 40).lineTo(x + CONTENT_WIDTH, y + 40).stroke();
  drawCellText(doc, 'Dados do sacado', x, y, clientWidth, { bold: true, size: 8 });
  doc.font('Helvetica').fontSize(6.8).fillColor('#111111')
    .text(clientAddressLines(data.client).join('\n'), x + 3, y + 14, {
      width: clientWidth - 6,
      height: h - 16,
      lineGap: 1,
      ellipsis: true
    });

  const values = [
    ['Valor Doc.', formatNumber(data.invoice.total), 'Valor Total', formatNumber(data.invoice.total)],
    ['Acréscimo', formatNumber(data.invoice.surcharge), 'NFS', data.invoice.nfs || '-'],
    ['Desconto', formatNumber(data.invoice.discount), 'Emissão', formatDate(data.invoice.issuedAt)]
  ];
  values.forEach((row, index) => {
    const rowY = y + (index * 20);
    drawCellText(doc, `${row[0]}\n${row[1]}`, x + clientWidth, rowY, valueWidth, {
      size: 5.8,
      height: 18,
      lineGap: 1
    });
    drawCellText(doc, `${row[2]}\n${row[3]}`, x + clientWidth + valueWidth, rowY, valueWidth, {
      size: 5.8,
      height: 18,
      lineGap: 1
    });
  });
};

const TABLE_COLUMNS = [
  ['Minuta', 29, 'minute', 'left'],
  ['CTE/NFSE', 42, 'cte', 'left'],
  ['Coleta', 30, 'collection', 'left'],
  ['Data', 42, 'date', 'left'],
  ['Nota', 41, 'note', 'left'],
  ['NF. valor', 43, 'noteValue', 'right'],
  ['Aut.', 44, 'authorization', 'left'],
  ['Origem / Cidade', 93, 'origin', 'left'],
  ['Destino / Cidade', 93, 'destination', 'left'],
  ['Taxado', 34, 'taxedWeight', 'right'],
  ['Volumes', 34, 'volumes', 'right'],
  ['Frete', 42, 'freight', 'right']
];

const displayShipmentValue = (shipment, key) => {
  if (['noteValue', 'taxedWeight', 'freight'].includes(key)) return formatNumber(shipment[key]);
  if (key === 'volumes') {
    const value = numberValue(shipment[key]);
    return value === null ? '-' : formatNumber(value, 0);
  }
  return shipment[key];
};

const drawTableHeader = (doc, y) => {
  let x = PAGE.margin;
  const h = 16;
  TABLE_COLUMNS.forEach(([label, width]) => {
    drawBox(doc, x, y, width, h);
    drawCellText(doc, label, x, y, width, {
      bold: true,
      size: 5.7,
      align: 'center',
      topPadding: 5,
      height: 10
    });
    x += width;
  });
  return y + h;
};

const shipmentHeight = (doc, shipment) => {
  const originHeight = doc.heightOfString(safeText(shipment.origin), { width: 94 });
  const destinationHeight = doc.heightOfString(safeText(shipment.destination), { width: 95 });
  const base = Math.max(22, originHeight + 6, destinationHeight + 6);
  return base + (shipment.observation ? 12 : 0);
};

const drawShipment = (doc, shipment, y) => {
  const rowHeight = shipmentHeight(doc.font('Helvetica').fontSize(5.6), shipment);
  const mainHeight = shipment.observation ? rowHeight - 12 : rowHeight;
  let x = PAGE.margin;
  TABLE_COLUMNS.forEach(([, width, key, align]) => {
    drawBox(doc, x, y, width, mainHeight);
    drawCellText(doc, displayShipmentValue(shipment, key), x, y, width, {
      size: 5.4,
      align,
      height: mainHeight - 4,
      topPadding: 4
    });
    x += width;
  });
  if (shipment.observation) {
    drawBox(doc, PAGE.margin, y + mainHeight, CONTENT_WIDTH, 12);
    drawCellText(doc, `Obs.: ${shipment.observation}`, PAGE.margin, y + mainHeight, CONTENT_WIDTH, {
      size: 5.2,
      height: 9,
      topPadding: 2
    });
  }
  return y + rowHeight;
};

const shipmentTotals = (shipments) => ({
  noteValue: shipments.reduce((sum, item) => sum + (numberValue(item.noteValue) || 0), 0),
  taxedWeight: shipments.reduce((sum, item) => sum + (numberValue(item.taxedWeight) || 0), 0),
  volumes: shipments.reduce((sum, item) => sum + (numberValue(item.volumes) || 0), 0),
  freight: shipments.reduce((sum, item) => sum + (numberValue(item.freight) || 0), 0)
});

const drawTotals = (doc, shipments, y) => {
  const totals = shipmentTotals(shipments);
  const h = 15;
  drawBox(doc, PAGE.margin, y, CONTENT_WIDTH, h);
  drawCellText(doc, `Qtd. Remessas     ${shipments.length}`, PAGE.margin, y, 105, {
    bold: true,
    size: 6.2,
    topPadding: 4
  });
  drawCellText(doc, 'Totais', PAGE.margin + 105, y, 70, {
    bold: true,
    size: 6.2,
    topPadding: 4
  });
  drawCellText(doc, formatNumber(totals.noteValue), PAGE.margin + 175, y, 155, {
    bold: true,
    size: 6.2,
    align: 'right',
    topPadding: 4
  });
  drawCellText(doc, formatNumber(totals.taxedWeight), PAGE.margin + 430, y, 45, {
    bold: true,
    size: 6.2,
    align: 'right',
    topPadding: 4
  });
  drawCellText(doc, formatNumber(totals.volumes, 0), PAGE.margin + 475, y, 42, {
    bold: true,
    size: 6.2,
    align: 'right',
    topPadding: 4
  });
  drawCellText(doc, formatNumber(totals.freight), PAGE.margin + 517, y, 50, {
    bold: true,
    size: 6.2,
    align: 'right',
    topPadding: 4
  });
  return y + h;
};

const drawLegalFooter = (doc, data) => {
  const y = PAGE.height - 72;
  doc.font('Helvetica').fontSize(5.3).fillColor('#111111')
    .text(legalTextFor(data?.issuer?.name), PAGE.margin, y, {
      width: CONTENT_WIDTH,
      align: 'justify',
      lineGap: 0.5
    });
  doc.fontSize(7).text(`Total: ${formatNumber(data?.invoice?.total)}`, PAGE.margin, y + 28, {
    width: 150
  });
  doc.text('Em ______/______/______', 205, y + 28, { width: 125, align: 'center' });
  doc.text('_________________________________________', 390, y + 28, { width: 190, align: 'center' });
  doc.fontSize(8).text('Data do aceite', 205, y + 42, { width: 125, align: 'center' });
  doc.text('Assinatura', 390, y + 42, { width: 190, align: 'center' });
};

const drawDetailPages = (doc, data, barcode) => {
  const shipments = data.shipments.length ? data.shipments : [{
    minute: '-',
    cte: '-',
    collection: '-',
    date: '-',
    note: '-',
    noteValue: null,
    authorization: '-',
    origin: 'Detalhamento não disponibilizado pela API da Brudam',
    destination: '-',
    destinationState: '-',
    taxedWeight: null,
    volumes: null,
    freight: data.invoice.total,
    observation: '',
    service: 'Não informado'
  }];
  let pageShipments = [];
  let y = 0;

  const startPage = () => {
    doc.addPage({ size: 'A4', margin: 0 });
    drawInvoiceHeader(doc, data, barcode);
    drawClientBlock(doc, data);
    y = drawTableHeader(doc, 143);
    pageShipments = [];
  };

  startPage();
  shipments.forEach((shipment) => {
    const height = shipmentHeight(doc.font('Helvetica').fontSize(5.6), shipment);
    if (y + height + 18 > PAGE.height - 90) {
      drawTotals(doc, pageShipments, y);
      drawLegalFooter(doc, data);
      startPage();
    }
    y = drawShipment(doc, shipment, y);
    pageShipments.push(shipment);
  });
  drawTotals(doc, pageShipments, y);
  drawLegalFooter(doc, data);
};

const buildInvoicePdf = async (data) => {
  const barcodeText = safeText(data?.invoice?.id, '0');
  let barcode = null;
  try {
    barcode = await bwipjs.toBuffer({
      bcid: 'code128',
      text: barcodeText,
      scale: 2,
      height: 10,
      includetext: false,
      padding: 0
    });
  } catch {
    // O número textual permanece visível se o código de barras não puder ser gerado.
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      autoFirstPage: false,
      size: 'A4',
      margin: 0,
      compress: true,
      info: {
        Title: `Fatura ${safeText(data.invoice.id)}`,
        Author: safeText(data?.issuer?.name, COMPANY.name),
        Subject: 'Fatura de prestação de serviços'
      }
    });
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    drawDetailPages(doc, data, barcode);
    doc.end();
  });
};

module.exports = {
  COMPANY,
  exactInvoiceRecord,
  companyFromPayload,
  normalizedCompany,
  linkedDocumentsFromInvoice,
  linkedDocumentsFromDoccob,
  minuteDataFromPayload,
  detailIdentifiers,
  occurrenceMinuteIdentifiers,
  occurrenceCteNumbers,
  minuteIdsFromCostsPayload,
  minuteDetailMatchesNote,
  fetchMinuteDetailsForNote,
  resolveDoccobTransportDetail,
  shipmentFromDetail,
  requestExactInvoice,
  fetchInvoicePdfData,
  buildInvoicePdf
};
