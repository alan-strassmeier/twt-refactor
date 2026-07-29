const BASE_URL = String(process.env.BRUDAM_API_URL || 'https://twt.brudam.com.br/api/v1').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 20000;
const COMPANY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COMPANY_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const COMPANY_LOOKUP_CONCURRENCY = 6;
const COMPANY_INVOICES_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_COMPANY_INVOICE_PAGES = 50;
const STATUS_LABELS = {
  0: 'Em aberto',
  1: 'Liquidada',
  2: 'Cancelada'
};

let cachedToken = '';
let cachedTokenExpiresAt = 0;
const companyNameCache = new Map();
const companyInvoicesCache = new Map();

const brudamRequest = async (path, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { status: 0, message: 'Resposta inválida da Brudam.' };
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
};

const tokenExpiration = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000;
  } catch {
    return Date.now() + 240000;
  }
};

const getAccessToken = async (forceRefresh = false) => {
  if (!forceRefresh && cachedToken && Date.now() < cachedTokenExpiresAt - 30000) return cachedToken;
  const usuario = String(process.env.BRUDAM_API_USER || '');
  const senha = String(process.env.BRUDAM_API_PASSWORD || '');
  if (!/^[A-Fa-f0-9]{32}$/.test(usuario) || !/^[A-Fa-f0-9]{64}$/.test(senha)) {
    throw Object.assign(new Error('Integração Brudam não configurada.'), { statusCode: 503 });
  }

  const { response, payload } = await brudamRequest('/acesso/auth/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  const token = payload?.data?.access_key;
  if (!response.ok || typeof token !== 'string' || !token) {
    throw Object.assign(new Error(payload?.message || 'Falha de autenticação na Brudam.'), { statusCode: 502 });
  }
  cachedToken = token;
  cachedTokenExpiresAt = tokenExpiration(token);
  return token;
};

const requestInvoices = async (query) => {
  const path = `/financeiro/faturas?${query}`;
  let token = await getAccessToken();
  let result = await brudamRequest(path, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
  if (result.response.status !== 401) return result;

  cachedToken = '';
  cachedTokenExpiresAt = 0;
  token = await getAccessToken(true);
  return brudamRequest(path, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
};

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const integer = (value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
};

const buildInvoiceQuery = (input = {}) => {
  const params = new URLSearchParams();
  const dateFilters = [
    'emissao[gt]', 'emissao[gte]', 'emissao[lt]', 'emissao[lte]', 'emissao[eq]',
    'vencimento[gt]', 'vencimento[gte]', 'vencimento[lt]', 'vencimento[lte]', 'vencimento[eq]'
  ];
  for (const key of dateFilters) {
    const value = String(input[key] || '').trim();
    if (value) {
      if (!validDate(value)) throw Object.assign(new Error(`Data inválida em ${key}.`), { statusCode: 422 });
      params.set(key, value);
    }
  }

  const status = String(input.status ?? '').trim();
  if (status) {
    if (!['0', '1', '2'].includes(status)) {
      throw Object.assign(new Error('Status inválido.'), { statusCode: 422 });
    }
    params.set('status', status);
  }

  const cnpj = String(input.cnpj || '').replace(/\D/g, '');
  let exactCnpj = null;
  if (cnpj) {
    if (cnpj.length !== 14) throw Object.assign(new Error('CNPJ inválido.'), { statusCode: 422 });
    exactCnpj = cnpj;
    params.set('cnpj', cnpj);
  }

  const idValue = input.id;
  let exactId = null;
  if (idValue !== undefined && idValue !== null && String(idValue).trim() !== '') {
    const id = integer(idValue, { min: 1 });
    if (id === null) throw Object.assign(new Error('Número da fatura inválido.'), { statusCode: 422 });
    exactId = id;
    params.set('id[eq]', String(id));
  }

  const limit = integer(input.limit, { min: 1, max: 100 }) ?? 100;
  const skip = exactId === null
    ? integer(input.skip, { min: 0, max: 1000000 }) ?? 0
    : 0;
  params.set('limit', String(limit));
  params.set('skip', String(skip));
  return { query: params.toString(), limit, skip, exactId, exactCnpj };
};

const numberValue = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.includes(',')
    ? value.replace(/\./g, '').replace(',', '.')
    : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

const firstValue = (object, keys) => {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
};

const normalizeInvoice = (invoice) => {
  const status = integer(invoice?.status, { min: 0, max: 2 });
  const total = numberValue(firstValue(invoice, ['valor_total', 'valorTotal', 'valor']));
  const explicitPaid = numberValue(firstValue(invoice, ['valor_pago', 'valorPago', 'pago', 'valor_liquidado']));
  const paid = explicitPaid ?? (status === 1 && total !== null ? total : 0);
  const explicitBalance = numberValue(firstValue(invoice, ['saldo', 'valor_saldo', 'saldo_devedor']));
  const balance = explicitBalance ?? (total !== null ? Math.max(total - paid, 0) : null);
  const client = invoice?.cliente && typeof invoice.cliente === 'object' ? invoice.cliente : {};

  return {
    id: firstValue(invoice, ['fatura', 'numero', 'id']),
    internalId: firstValue(invoice, ['id']),
    issuedAt: firstValue(invoice, ['emissao', 'data_emissao']),
    dueAt: firstValue(invoice, ['vencimento', 'data_vencimento']),
    paidAt: firstValue(invoice, ['data_pagamento', 'data_pgto', 'pagamento', 'data_liquidacao']),
    client: firstValue(client, ['fantasia', 'razao', 'nome']) ||
      firstValue(invoice, ['cliente_nome', 'nome_cliente', 'razao_social_cliente', 'empresa']) || '',
    clientDocument: firstValue(client, ['cnpj', 'documento']) ||
      firstValue(invoice, ['cnpj_cliente']) || '',
    total,
    paid,
    balance,
    status,
    statusLabel: String(
      firstValue(invoice, ['situacao', 'status_descricao']) ||
      STATUS_LABELS[status] ||
      'Não informado'
    )
  };
};

const companyTradeNameFromPayload = (payload, cnpj) => {
  if (!payload || Number(payload.status) !== 1 || !Array.isArray(payload.data)) return '';
  const expectedCnpj = String(cnpj || '').replace(/\D/g, '');
  const company = payload.data.find((item) =>
    String(item?.cnpj || '').replace(/\D/g, '') === expectedCnpj
  );
  return String(firstValue(company, ['fantasia', 'razao']) || '').trim();
};

const fetchCompanyTradeName = async (cnpj) => {
  const normalizedCnpj = String(cnpj || '').replace(/\D/g, '');
  if (normalizedCnpj.length !== 14) return '';

  const cached = companyNameCache.get(normalizedCnpj);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  if (cached) companyNameCache.delete(normalizedCnpj);

  const path = `/cadastro/empresas?${new URLSearchParams({ cnpj: normalizedCnpj })}`;
  let token = await getAccessToken();
  let result = await brudamRequest(path, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
  if (result.response.status === 401) {
    cachedToken = '';
    cachedTokenExpiresAt = 0;
    token = await getAccessToken(true);
    result = await brudamRequest(path, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
    });
  }

  const name = result.response.ok
    ? companyTradeNameFromPayload(result.payload, normalizedCnpj)
    : '';
  companyNameCache.set(normalizedCnpj, {
    name,
    expiresAt: Date.now() + (name ? COMPANY_CACHE_TTL_MS : COMPANY_NEGATIVE_CACHE_TTL_MS)
  });
  return name;
};

const enrichInvoicesWithCompanies = async (invoices, lookup = fetchCompanyTradeName) => {
  const namesByCnpj = new Map();
  const cnpjs = [...new Set(invoices
    .filter((invoice) => !invoice.client)
    .map((invoice) => String(invoice.clientDocument || '').replace(/\D/g, ''))
    .filter((cnpj) => cnpj.length === 14))];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(COMPANY_LOOKUP_CONCURRENCY, cnpjs.length) },
    async () => {
      while (nextIndex < cnpjs.length) {
        const cnpj = cnpjs[nextIndex];
        nextIndex += 1;
        let name = '';
        try {
          name = await lookup(cnpj);
        } catch {
          // A fatura continua disponível mesmo se o cadastro da empresa falhar.
        }
        namesByCnpj.set(cnpj, name);
      }
    }
  );
  await Promise.all(workers);

  return invoices.map((invoice) => {
    if (invoice.client) return invoice;
    const cnpj = String(invoice.clientDocument || '').replace(/\D/g, '');
    const client = namesByCnpj.get(cnpj) || '';
    return client ? { ...invoice, client } : invoice;
  });
};

const isInvoiceObject = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  ['id', 'fatura', 'numero', 'valor', 'valor_total', 'emissao', 'vencimento', 'cliente']
    .some((key) => value[key] !== undefined);

const findInvoiceList = (value, depth = 0, visited = new Set()) => {
  if (depth > 5 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const invoices = value.filter(isInvoiceObject);
    if (invoices.length > 0) return invoices;
    let foundEmptyList = false;
    for (const item of value) {
      const nested = findInvoiceList(item, depth + 1, visited);
      if (Array.isArray(nested) && nested.length > 0) return nested;
      if (Array.isArray(nested)) foundEmptyList = true;
    }
    return foundEmptyList ? [] : null;
  }
  if (typeof value !== 'object' || visited.has(value)) return null;
  if (isInvoiceObject(value)) return [value];
  visited.add(value);

  const keys = Object.keys(value);
  if (keys.length === 0) return [];
  const preferredKeys = [
    'faturas', 'items', 'registros', 'resultados', 'dados', 'rows', 'records', 'data'
  ];
  let foundEmptyList = false;
  for (const key of preferredKeys) {
    if (!(key in value)) continue;
    const nested = findInvoiceList(value[key], depth + 1, visited);
    if (Array.isArray(nested) && nested.length > 0) return nested;
    if (Array.isArray(nested)) foundEmptyList = true;
  }
  for (const nestedValue of Object.values(value)) {
    const nested = findInvoiceList(nestedValue, depth + 1, visited);
    if (Array.isArray(nested) && nested.length > 0) return nested;
    if (Array.isArray(nested)) foundEmptyList = true;
  }
  return foundEmptyList ? [] : null;
};

const invoiceListFromPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload?.data?.documentos)) return payload.data.documentos;
  return findInvoiceList(payload.data);
};

const invoicePageFingerprint = (invoices) => invoices
  .map((invoice) => String(firstValue(invoice, ['fatura', 'numero', 'id']) || ''))
  .join('|');

const collectAllInvoicePages = async (
  initialQuery,
  firstInvoices,
  requestPage = requestInvoices
) => {
  const params = new URLSearchParams(initialQuery);
  const pageSize = integer(params.get('limit'), { min: 1, max: 100 }) ?? 100;
  const invoices = [...firstInvoices];
  const fingerprints = new Set();
  if (firstInvoices.length) fingerprints.add(invoicePageFingerprint(firstInvoices));
  let pagesLoaded = 1;

  if (firstInvoices.length < pageSize) return { invoices, pagesLoaded };

  for (let page = 1; page < MAX_COMPANY_INVOICE_PAGES; page += 1) {
    params.set('skip', String(page * pageSize));
    const result = await requestPage(params.toString());
    const pageInvoices = invoiceListFromPayload(result.payload);
    if (
      !result.response.ok ||
      Number(result.payload?.status) !== 1 ||
      pageInvoices === null
    ) {
      throw Object.assign(
        new Error('Não foi possível carregar todas as faturas do cliente.'),
        { statusCode: 502 }
      );
    }
    pagesLoaded += 1;
    if (pageInvoices.length === 0) return { invoices, pagesLoaded };

    const fingerprint = invoicePageFingerprint(pageInvoices);
    if (fingerprints.has(fingerprint)) {
      throw Object.assign(
        new Error('A Brudam repetiu uma página durante a consulta por CNPJ.'),
        { statusCode: 502 }
      );
    }
    fingerprints.add(fingerprint);
    invoices.push(...pageInvoices);
    if (pageInvoices.length < pageSize) return { invoices, pagesLoaded };
  }

  throw Object.assign(
    new Error('A consulta por CNPJ ultrapassou o limite seguro de páginas.'),
    { statusCode: 502 }
  );
};

const filterInvoicesById = (invoices, exactId) => {
  if (exactId === null || exactId === undefined) return invoices;
  return invoices.filter((invoice) => String(invoice?.id ?? '') === String(exactId));
};

const filterAndSortCompanyInvoices = (invoices, exactCnpj) => {
  const normalizedCnpj = String(exactCnpj || '').replace(/\D/g, '');
  return invoices.filter((invoice) =>
    String(invoice.clientDocument || '').replace(/\D/g, '') === normalizedCnpj
  ).sort((left, right) => {
    const leftDate = Date.parse(String(left.issuedAt || '')) || 0;
    const rightDate = Date.parse(String(right.issuedAt || '')) || 0;
    if (leftDate !== rightDate) return rightDate - leftDate;
    return Number(right.id || 0) - Number(left.id || 0);
  });
};

const companyInvoicesCacheKey = (query) => {
  const params = new URLSearchParams(query);
  params.delete('limit');
  params.delete('skip');
  params.sort();
  return params.toString();
};

const plainInvoiceIdQuery = (query, exactId) => {
  const params = new URLSearchParams(query);
  params.delete('id[eq]');
  params.set('id', String(exactId));
  return params.toString();
};

const fetchInvoices = async (input) => {
  const { query, limit, skip, exactId, exactCnpj } = buildInvoiceQuery(input);
  let { response, payload } = await requestInvoices(query);
  let rawInvoices = invoiceListFromPayload(payload);
  if (!response.ok || Number(payload?.status) !== 1 || rawInvoices === null) {
    console.error('[faturamento:brudam-response]', {
      httpStatus: response.status,
      apiStatus: payload?.status,
      dataType: Array.isArray(payload?.data) ? 'array' : typeof payload?.data,
      dataKeys: payload?.data && typeof payload.data === 'object'
        ? Object.keys(payload.data).slice(0, 20)
        : []
    });
    const upstreamMessage = String(payload?.message || '').trim();
    const error = new Error(
      upstreamMessage && upstreamMessage.toUpperCase() !== 'OK'
        ? upstreamMessage
        : 'Formato inesperado no retorno de faturas da Brudam.'
    );
    error.statusCode = response.status >= 400 ? response.status : 502;
    throw error;
  }
  let normalizedInvoices = rawInvoices.map(normalizeInvoice);
  let invoices = filterInvoicesById(normalizedInvoices, exactId);
  let upstreamCount = rawInvoices.length;
  let upstreamReportedCount = integer(payload?.data?.qtd_lancamentos, { min: 0 });
  let upstreamFilter = exactId !== null ? 'id[eq]' : (exactCnpj ? 'cnpj' : 'none');
  let fallbackAttempted = false;
  let allCompanyInvoicesLoaded = false;
  let pagesLoaded = 1;

  if (exactId !== null && invoices.length === 0) {
    fallbackAttempted = true;
    const fallbackQuery = plainInvoiceIdQuery(query, exactId);
    const fallbackResult = await requestInvoices(fallbackQuery);
    const fallbackRawInvoices = invoiceListFromPayload(fallbackResult.payload);
    if (
      fallbackResult.response.ok &&
      Number(fallbackResult.payload?.status) === 1 &&
      fallbackRawInvoices !== null
    ) {
      const fallbackNormalizedInvoices = fallbackRawInvoices.map(normalizeInvoice);
      const fallbackInvoices = filterInvoicesById(fallbackNormalizedInvoices, exactId);
      if (fallbackInvoices.length > 0 || fallbackRawInvoices.length < rawInvoices.length) {
        response = fallbackResult.response;
        payload = fallbackResult.payload;
        rawInvoices = fallbackRawInvoices;
        normalizedInvoices = fallbackNormalizedInvoices;
        invoices = fallbackInvoices;
        upstreamFilter = 'id';
        upstreamCount = rawInvoices.length;
        upstreamReportedCount = integer(payload?.data?.qtd_lancamentos, { min: 0 });
      }
    }
  }

  if (exactCnpj && exactId === null) {
    const cacheKey = companyInvoicesCacheKey(query);
    const cached = companyInvoicesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      invoices = cached.invoices;
      upstreamCount = cached.upstreamCount;
      upstreamReportedCount = cached.upstreamCount;
      pagesLoaded = cached.pagesLoaded;
    } else {
      if (cached) companyInvoicesCache.delete(cacheKey);
      const collected = await collectAllInvoicePages(query, rawInvoices);
      rawInvoices = collected.invoices;
      normalizedInvoices = rawInvoices.map(normalizeInvoice);
      invoices = filterAndSortCompanyInvoices(normalizedInvoices, exactCnpj);
      upstreamCount = rawInvoices.length;
      upstreamReportedCount = rawInvoices.length;
      pagesLoaded = collected.pagesLoaded;
      if (companyInvoicesCache.size >= 20) {
        companyInvoicesCache.delete(companyInvoicesCache.keys().next().value);
      }
      companyInvoicesCache.set(cacheKey, {
        invoices,
        upstreamCount,
        pagesLoaded,
        expiresAt: Date.now() + COMPANY_INVOICES_CACHE_TTL_MS
      });
    }
    allCompanyInvoicesLoaded = true;
  }

  invoices = await enrichInvoicesWithCompanies(invoices);

  return {
    invoices,
    pagination: {
      limit: allCompanyInvoicesLoaded ? invoices.length : limit,
      skip: allCompanyInvoicesLoaded ? 0 : skip,
      hasPrevious: allCompanyInvoicesLoaded ? false : skip > 0,
      hasMore: allCompanyInvoicesLoaded ? false : exactId === null && invoices.length === limit,
      upstreamReportedCount,
      upstreamCount,
      upstreamFilter,
      fallbackAttempted,
      allCompanyInvoicesLoaded,
      pagesLoaded
    }
  };
};

module.exports = {
  STATUS_LABELS,
  buildInvoiceQuery,
  normalizeInvoice,
  companyTradeNameFromPayload,
  enrichInvoicesWithCompanies,
  invoiceListFromPayload,
  collectAllInvoicePages,
  filterInvoicesById,
  filterAndSortCompanyInvoices,
  plainInvoiceIdQuery,
  fetchInvoices
};
