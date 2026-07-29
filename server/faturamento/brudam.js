const BASE_URL = String(process.env.BRUDAM_API_URL || 'https://twt.brudam.com.br/api/v1').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 20000;
const STATUS_LABELS = {
  0: 'Em aberto',
  1: 'Liquidada',
  2: 'Cancelada'
};

let cachedToken = '';
let cachedTokenExpiresAt = 0;

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
  if (cnpj) {
    if (cnpj.length !== 14) throw Object.assign(new Error('CNPJ inválido.'), { statusCode: 422 });
    params.set('cnpj', cnpj);
  }

  const idValue = input.id;
  if (idValue !== undefined && idValue !== null && String(idValue).trim() !== '') {
    const id = integer(idValue, { min: 1 });
    if (id === null) throw Object.assign(new Error('Número da fatura inválido.'), { statusCode: 422 });
    params.set('id', String(id));
  }

  const limit = integer(input.limit, { min: 1, max: 100 }) ?? 100;
  const skip = integer(input.skip, { min: 0, max: 1000000 }) ?? 0;
  params.set('limit', String(limit));
  params.set('skip', String(skip));
  return { query: params.toString(), limit, skip };
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
    id: firstValue(invoice, ['id', 'fatura', 'numero']),
    issuedAt: firstValue(invoice, ['emissao', 'data_emissao']),
    dueAt: firstValue(invoice, ['vencimento', 'data_vencimento']),
    paidAt: firstValue(invoice, ['data_pagamento', 'data_pgto', 'pagamento', 'data_liquidacao']),
    client: firstValue(client, ['fantasia', 'razao', 'nome']) || firstValue(invoice, ['cliente_nome', 'empresa']) || '',
    clientDocument: firstValue(client, ['cnpj', 'documento']) || '',
    total,
    paid,
    balance,
    status,
    statusLabel: String(firstValue(invoice, ['situacao']) || STATUS_LABELS[status] || 'Não informado')
  };
};

const fetchInvoices = async (input) => {
  const { query, limit, skip } = buildInvoiceQuery(input);
  const { response, payload } = await requestInvoices(query);
  if (!response.ok || Number(payload?.status) !== 1 || !Array.isArray(payload?.data)) {
    const error = new Error(payload?.message || 'Não foi possível consultar as faturas.');
    error.statusCode = response.status >= 400 ? response.status : 502;
    throw error;
  }
  const invoices = payload.data.map(normalizeInvoice);
  return {
    invoices,
    pagination: {
      limit,
      skip,
      hasPrevious: skip > 0,
      hasMore: invoices.length === limit
    }
  };
};

module.exports = {
  STATUS_LABELS,
  buildInvoiceQuery,
  normalizeInvoice,
  fetchInvoices
};
