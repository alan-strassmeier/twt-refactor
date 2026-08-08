const {
  authenticatedGet,
  normalizeInvoice
} = require('./brudam');
const { requestExactInvoice } = require('./invoice-pdf');
const { findDoccobForInvoice } = require('./r2-doccob');
const { isValidCteAccessKey } = require('./doccob');

const MAX_CTES_PER_INVOICE = 50;
const XML_MAX_BYTES = 2 * 1024 * 1024;

const digits = (value) => String(value || '').replace(/\D/g, '');

const validInvoiceId = (value) => /^\d{1,20}$/.test(String(value || '')) && Number(value) > 0;

const cteKeysFromInvoice = (invoice) => {
  const documents = Array.isArray(invoice?.documentos) ? invoice.documentos : [];
  return documents.flatMap((document) => [
    document?.chave,
    document?.chave_cte,
    document?.chCTe,
    document?.cte?.chave
  ]);
};

const normalizeCteKeys = (values) => [...new Set(values
  .map(digits)
  .filter(isValidCteAccessKey))]
  .slice(0, MAX_CTES_PER_INVOICE);

const resolveInvoiceCteKeys = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) {
    throw Object.assign(new Error('Número da fatura inválido.'), { statusCode: 422 });
  }

  const requestInvoice = dependencies.requestExactInvoice || requestExactInvoice;
  const findDoccob = dependencies.findDoccobForInvoice || findDoccobForInvoice;
  const { invoice } = await requestInvoice(invoiceId);
  const normalized = normalizeInvoice(invoice);
  const clientCnpj = digits(normalized.clientDocument);
  let doccob = null;
  try {
    doccob = await findDoccob({
      invoiceId: normalized.id || invoiceId,
      clientCnpj
    });
  } catch (error) {
    console.warn('[faturamento:documentos-doccob]', {
      invoiceId,
      clientCnpj,
      error: error.message
    });
  }

  const doccobKeys = (Array.isArray(doccob?.transports) ? doccob.transports : [])
    .map((transport) => transport?.accessKey);
  return {
    invoiceId: String(normalized.id || invoiceId),
    cteKeys: normalizeCteKeys([...doccobKeys, ...cteKeysFromInvoice(invoice)]),
    source: doccobKeys.some((value) => isValidCteAccessKey(digits(value)))
      ? 'doccob'
      : 'brudam'
  };
};

const looksLikeXml = (value) => /^\s*(?:<\?xml[^>]*>\s*)?<(?:\w+:)?(?:cteProc|CTe)\b/i.test(value);

const safeCteXml = (value) => {
  const xml = String(value || '').replace(/^\uFEFF/, '').trim();
  if (!xml || Buffer.byteLength(xml, 'utf8') > XML_MAX_BYTES) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !looksLikeXml(xml)) return null;
  return xml;
};

const decodeXmlValue = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const direct = safeCteXml(value);
  if (direct) return direct;
  try {
    return safeCteXml(Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

const xmlValuesFromPayload = (payload) => {
  const values = [];
  const visited = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (typeof value.xml === 'string') values.push(value.xml);
    Object.entries(value)
      .filter(([key]) => key !== 'xml')
      .forEach(([, item]) => visit(item, depth + 1));
  };
  visit(payload?.data);
  return values;
};

const decodeCteXmlPayload = (payload) => {
  if (!payload || Number(payload.status) !== 1) return [];
  const xmls = xmlValuesFromPayload(payload)
    .map(decodeXmlValue)
    .filter(Boolean);
  return [...new Map(xmls.map((xml) => [xml, xml])).values()];
};

const accessKeyFromXml = (xml) => {
  const protocol = String(xml || '').match(/<(?:\w+:)?chCTe\b[^>]*>\s*(\d{44})\s*<\/(?:\w+:)?chCTe>/i);
  if (protocol) return protocol[1];
  const identifier = String(xml || '').match(/<(?:\w+:)?infCte\b[^>]*\bId=["']CTe(\d{44})["']/i);
  return identifier?.[1] || '';
};

const fetchCteXmls = async (cteKeys, get = authenticatedGet) => {
  const keys = normalizeCteKeys(cteKeys);
  if (!keys.length) return [];

  const query = new URLSearchParams({ chave: keys.join(',') });
  const result = await get(`/dfe/cte?${query}`);
  if (!result.response.ok || Number(result.payload?.status) !== 1) {
    throw Object.assign(new Error(result.payload?.message || 'CT-e não encontrado na Brudam.'), {
      statusCode: result.response.status === 404 ? 404 : 502
    });
  }

  const byKey = new Map(decodeCteXmlPayload(result.payload)
    .map((xml) => [accessKeyFromXml(xml), xml])
    .filter(([key]) => keys.includes(key)));

  if (byKey.size < keys.length && keys.length > 1) {
    for (const key of keys.filter((item) => !byKey.has(item))) {
      try {
        const single = await get(`/dfe/cte?${new URLSearchParams({ chave: key })}`);
        decodeCteXmlPayload(single.payload).forEach((xml) => {
          const returnedKey = accessKeyFromXml(xml);
          if (returnedKey === key) byKey.set(key, xml);
        });
      } catch {
        // A resposta em lote ainda pode conter os demais CT-es válidos.
      }
    }
  }

  const ordered = keys.map((key) => byKey.get(key)).filter(Boolean);
  if (!ordered.length) {
    throw Object.assign(new Error('A Brudam não retornou XML válido para os CT-es da fatura.'), {
      statusCode: 502
    });
  }
  return ordered;
};

module.exports = {
  MAX_CTES_PER_INVOICE,
  XML_MAX_BYTES,
  normalizeCteKeys,
  resolveInvoiceCteKeys,
  decodeCteXmlPayload,
  accessKeyFromXml,
  fetchCteXmls
};
