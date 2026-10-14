const { randomUUID } = require('node:crypto');
const { redisCommand } = require('./boleto-store');
const {
  authenticatedGet,
  buildInvoiceQuery,
  companyRecordsFromPayload,
  invoiceListFromPayload,
  normalizeVisibleInvoices
} = require('./brudam');
const { normalizedDateOnly } = require('./billing-rules');

const SNAPSHOT_KEY = 'faturamento:clientes-inativos:lista:v1';
const REFRESH_KEY = 'faturamento:clientes-inativos:atualizacao:v1';
const LOCK_KEY = 'faturamento:clientes-inativos:atualizacao-lock:v1';
const PAGE_SIZE = 100;
const PAGES_PER_STEP = 2;
const NAME_LOOKUPS_PER_STEP = 10;
const STEP_BUDGET_MS = 45000;
const RUN_TTL_SECONDS = 4 * 60 * 60;
const INACTIVE_DAYS = 31;

const SAVE_PROGRESS_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  'if not current then return 0 end',
  'if cjson.decode(current).runId ~= ARGV[1] then return 0 end',
  "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])",
  'return 1'
].join(' ');
const PUBLISH_SNAPSHOT_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  'if not current then return 0 end',
  'if cjson.decode(current).runId ~= ARGV[1] then return 0 end',
  "redis.call('SET', KEYS[2], ARGV[2])",
  "redis.call('DEL', KEYS[1])",
  'return 1'
].join(' ');
const RELEASE_LOCK_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "return redis.call('DEL', KEYS[1]) end",
  'return 0'
].join(' ');

const parseRecord = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const saoPauloDate = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const validDate = (value) => {
  const iso = normalizedDateOnly(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? '' : iso;
};

const daysBetween = (start, end) => Math.floor(
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000
);

const progress = (run) => run && ({
  runId: run.runId,
  startedAt: run.startedAt,
  phase: run.phase || 'invoices',
  pagesRead: run.pagesRead,
  invoicesRead: run.invoicesRead,
  companiesFound: Object.keys(run.companies || {}).length,
  namesLookedUp: run.nameLookupIndex || 0,
  namesTotal: run.nameLookupTotal || 0
});

const getInactiveSnapshot = async (command = redisCommand) =>
  parseRecord(await command('GET', SNAPSHOT_KEY));

const getInactiveRefresh = async (command = redisCommand) =>
  progress(parseRecord(await command('GET', REFRESH_KEY)));

const startInactiveRefresh = async ({ now = new Date() } = {}, command = redisCommand) => {
  const run = {
    runId: randomUUID(),
    startedAt: now.toISOString(),
    asOfDate: saoPauloDate(now),
    skip: 0,
    pagesRead: 0,
    invoicesRead: 0,
    ignoredInvoices: 0,
    expectedTotal: null,
    lastFingerprint: '',
    phase: 'invoices',
    nameLookupIndex: 0,
    nameLookupTotal: 0,
    companies: {}
  };
  const created = await command('SET', REFRESH_KEY, JSON.stringify(run), 'NX', 'EX', String(RUN_TTL_SECONDS));
  if (created === 'OK') return progress(run);
  const active = parseRecord(await command('GET', REFRESH_KEY));
  if (active) return progress(active);
  throw Object.assign(new Error('Não foi possível iniciar a atualização. Tente novamente.'), {
    statusCode: 503, expose: true
  });
};

const fetchInactiveInvoicePage = async (skip) => {
  const { query } = buildInvoiceQuery({ limit: PAGE_SIZE, skip });
  const { response, payload } = await authenticatedGet(`/financeiro/faturas?${query}`);
  const raw = invoiceListFromPayload(payload);
  if (!response.ok || Number(payload?.status) !== 1 || raw === null) {
    const error = new Error('Não foi possível consultar todas as faturas na Brudam.');
    error.statusCode = response.status >= 400 ? response.status : 502;
    throw error;
  }
  return {
    invoices: normalizeVisibleInvoices(raw),
    rawCount: raw.length,
    reportedTotal: payload?.data?.qtd_lancamentos !== undefined &&
      payload?.data?.qtd_lancamentos !== null &&
      Number.isSafeInteger(Number(payload.data.qtd_lancamentos))
      ? Number(payload.data.qtd_lancamentos)
      : null,
    fingerprint: JSON.stringify(raw.map((invoice) => [
      invoice?.id, invoice?.fatura, invoice?.emissao
    ]))
  };
};

const retryable = (error) => Number(error?.statusCode) === 429 ||
  Number(error?.statusCode) >= 500 ||
  error?.name === 'AbortError' ||
  /fetch failed|timeout|network|socket|limite de requisi/i.test(String(error?.message || ''));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const queryPage = async (skip, { fetchPage, wait }) => {
  let error;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const page = await fetchPage(skip);
      if (page.rawCount === 0 && attempt < 2) {
        await wait(400 * attempt);
        continue;
      }
      return page;
    } catch (cause) {
      error = cause;
      if (attempt === 2 || !retryable(cause)) throw cause;
      await wait(500 * attempt);
    }
  }
  throw error || new Error('Consulta de faturas não concluída.');
};

const tradeNameFromPayload = (payload, cnpj) => {
  if (Number(payload?.status) !== 1) return '';
  const company = companyRecordsFromPayload(payload).find((record) =>
    String(record.cnpj || record.cpf_cnpj || record.documento || '').replace(/\D/g, '') === cnpj
  );
  const name = String(company?.fantasia || company?.nome_fantasia || '').trim().slice(0, 200);
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return !name || ['nao informado', 'nao informada', '-'].includes(normalized) ||
    name.replace(/\D/g, '') === cnpj ? '' : name;
};

const fetchInactiveTradeName = async (cnpj) => {
  const { response, payload } = await authenticatedGet(`/cadastro/empresas?cnpj=${cnpj}`);
  if (!response.ok) {
    throw Object.assign(new Error('Não foi possível consultar o nome fantasia na Brudam.'), {
      statusCode: response.status || 502
    });
  }
  return tradeNameFromPayload(payload, cnpj);
};

const queryTradeName = async (cnpj, { fetchTradeName, wait }) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetchTradeName(cnpj);
    } catch (error) {
      if (attempt === 2 || !retryable(error)) throw error;
      await wait(500 * attempt);
    }
  }
  return '';
};

const inactiveCnpjs = (run) => Object.values(run.companies)
  .filter((company) => daysBetween(company.lastIssuedAt, run.asOfDate) >= INACTIVE_DAYS)
  .map((company) => company.cnpj)
  .sort();

const addInvoices = (run, invoices) => {
  for (const invoice of invoices) {
    const cnpj = String(invoice.clientDocument || '').replace(/\D/g, '');
    const issuedAt = validDate(invoice.issuedAt);
    if (cnpj.length !== 14 || !issuedAt) {
      run.ignoredInvoices += 1;
      continue;
    }
    const name = String(invoice.client || '').trim().slice(0, 200);
    const current = run.companies[cnpj];
    if (!current || issuedAt > current.lastIssuedAt) {
      run.companies[cnpj] = {
        cnpj,
        name: name || current?.name || cnpj,
        lastIssuedAt: issuedAt,
        lastInvoiceId: String(invoice.id || '').slice(0, 30)
      };
    } else if (name && (!current.name || current.name === cnpj)) {
      current.name = name;
    }
  }
};

const buildInactiveSnapshot = (run, now = new Date()) => {
  const clients = Object.values(run.companies)
    .map((company) => ({
      ...company,
      daysSinceLastInvoice: daysBetween(company.lastIssuedAt, run.asOfDate)
    }))
    .filter((company) => company.daysSinceLastInvoice >= INACTIVE_DAYS)
    .sort((left, right) =>
      right.daysSinceLastInvoice - left.daysSinceLastInvoice ||
      left.name.localeCompare(right.name, 'pt-BR') ||
      left.cnpj.localeCompare(right.cnpj)
    );
  return {
    updatedAt: now.toISOString(),
    asOfDate: run.asOfDate,
    thresholdDays: INACTIVE_DAYS,
    totalCompanies: Object.keys(run.companies).length,
    invoicesRead: run.invoicesRead,
    ignoredInvoices: run.ignoredInvoices,
    missingTradeNames: clients.filter((company) => company.name === 'Nome fantasia não localizado').length,
    clients
  };
};

const continueInactiveRefresh = async ({ runId } = {}, dependencies = {}) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(runId || ''))) {
    throw Object.assign(new Error('Identificador da atualização inválido.'), { statusCode: 422, expose: true });
  }
  const command = dependencies.command || redisCommand;
  const fetchPage = dependencies.fetchPage || fetchInactiveInvoicePage;
  const fetchTradeName = dependencies.fetchTradeName || fetchInactiveTradeName;
  const wait = dependencies.wait || pause;
  const now = dependencies.now || (() => new Date());
  const lockToken = randomUUID();
  const stepStartedAt = Date.now();
  if (await command('SET', LOCK_KEY, lockToken, 'NX', 'EX', '90') !== 'OK') {
    throw Object.assign(new Error('Outro lote da atualização está em andamento. Aguarde e tente novamente.'), {
      statusCode: 409, expose: true
    });
  }
  try {
    const run = parseRecord(await command('GET', REFRESH_KEY));
    if (!run || run.runId !== runId) {
      throw Object.assign(new Error('Atualização expirada. Clique em Atualizar para iniciar novamente.'), {
        statusCode: 409, expose: true
      });
    }
    run.phase ||= 'invoices';
    run.nameLookupIndex ||= 0;
    let complete = false;
    for (let pageIndex = 0; run.phase !== 'names' && pageIndex < PAGES_PER_STEP; pageIndex += 1) {
      if (pageIndex > 0 && Date.now() - stepStartedAt > STEP_BUDGET_MS - 25000) break;
      if (run.skip > 1000000) {
        throw Object.assign(new Error('A quantidade de faturas ultrapassou o limite de paginação.'), {
          statusCode: 503, expose: true
        });
      }
      if (pageIndex > 0) await wait(400);
      let page = await queryPage(run.skip, { fetchPage, wait });
      if (page.rawCount === PAGE_SIZE && page.fingerprint === run.lastFingerprint) {
        await wait(500);
        page = await queryPage(run.skip, { fetchPage, wait });
        if (page.fingerprint === run.lastFingerprint) {
          throw Object.assign(new Error('A Brudam repetiu a mesma página; a lista anterior foi preservada.'), {
            statusCode: 503, expose: true
          });
        }
      }
      if (page.rawCount === 0 && run.pagesRead === 0 && page.reportedTotal === null) {
        throw Object.assign(new Error('A Brudam não confirmou que não há faturas; a lista anterior foi preservada.'), {
          statusCode: 503, expose: true
        });
      }
      if (page.rawCount === 0 && run.expectedTotal > run.invoicesRead) {
        throw Object.assign(new Error('A Brudam encerrou a listagem antes de retornar todas as faturas.'), {
          statusCode: 503, expose: true
        });
      }
      if (!Number.isInteger(page.rawCount) || page.rawCount < 0 || page.rawCount > PAGE_SIZE) {
        throw Object.assign(new Error('A Brudam retornou uma página de tamanho inesperado.'), {
          statusCode: 502, expose: true
        });
      }
      if (run.pagesRead === 0 && page.reportedTotal !== null) {
        run.expectedTotal = page.reportedTotal;
      }
      addInvoices(run, page.invoices || []);
      run.invoicesRead += page.rawCount;
      run.pagesRead += 1;
      run.lastFingerprint = page.fingerprint;
      complete = page.rawCount < PAGE_SIZE;
      if (complete) {
        if (run.expectedTotal > run.invoicesRead) {
          throw Object.assign(new Error('A Brudam retornou menos faturas que o total informado.'), {
            statusCode: 503, expose: true
          });
        }
        if (run.expectedTotal === null && page.rawCount > 0) {
          if (Date.now() - stepStartedAt > STEP_BUDGET_MS - 25000) {
            throw Object.assign(new Error('A confirmação da última página excedeu o tempo seguro; tente continuar.'), {
              statusCode: 503, expose: true
            });
          }
          await wait(400);
          const confirmation = await queryPage(run.skip + page.rawCount, { fetchPage, wait });
          if (confirmation.rawCount > 0) {
            throw Object.assign(new Error('A Brudam retornou mais faturas após uma página parcial; a lista anterior foi preservada.'), {
              statusCode: 503, expose: true
            });
          }
        }
        run.phase = 'names';
        run.nameLookupTotal = inactiveCnpjs(run).length;
        break;
      }
      run.skip += PAGE_SIZE;
    }
    if (run.phase === 'names' && !complete) {
      const cnpjs = inactiveCnpjs(run);
      for (let index = 0;
        index < NAME_LOOKUPS_PER_STEP && run.nameLookupIndex < cnpjs.length;
        index += 1) {
        if (index > 0 && Date.now() - stepStartedAt > STEP_BUDGET_MS - 25000) break;
        if (index > 0) await wait(400);
        const cnpj = cnpjs[run.nameLookupIndex];
        const name = await queryTradeName(cnpj, { fetchTradeName, wait });
        run.companies[cnpj].name = name || 'Nome fantasia não localizado';
        run.nameLookupIndex += 1;
      }
      complete = run.nameLookupIndex >= cnpjs.length;
    } else if (run.phase === 'names') {
      complete = run.nameLookupTotal === 0;
    }
    if (complete) {
      const snapshot = buildInactiveSnapshot(run, now());
      const published = await command('EVAL', PUBLISH_SNAPSHOT_SCRIPT, '2',
        REFRESH_KEY, SNAPSHOT_KEY, runId, JSON.stringify(snapshot));
      if (Number(published) !== 1) throw new Error('A atualização foi substituída por outra execução.');
      return { complete: true, snapshot };
    }
    const saved = await command('EVAL', SAVE_PROGRESS_SCRIPT, '1', REFRESH_KEY,
      runId, JSON.stringify(run), String(RUN_TTL_SECONDS));
    if (Number(saved) !== 1) throw new Error('Não foi possível salvar o avanço da atualização.');
    return { complete: false, refresh: progress(run) };
  } finally {
    await command('EVAL', RELEASE_LOCK_SCRIPT, '1', LOCK_KEY, lockToken);
  }
};

module.exports = {
  SNAPSHOT_KEY,
  REFRESH_KEY,
  LOCK_KEY,
  INACTIVE_DAYS,
  saoPauloDate,
  validDate,
  daysBetween,
  addInvoices,
  buildInactiveSnapshot,
  tradeNameFromPayload,
  fetchInactiveInvoicePage,
  fetchInactiveTradeName,
  getInactiveSnapshot,
  getInactiveRefresh,
  startInactiveRefresh,
  continueInactiveRefresh
};
