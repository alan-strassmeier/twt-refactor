const { randomUUID } = require('node:crypto');
const seedCategories = require('./cobranca-contacts-seed.json');
const { redisCommand } = require('./boleto-store');
const {
  contactId,
  digits,
  normalizeContactNames
} = require('./cobranca-contact-import');
const {
  BILLING_METHODS,
  normalizedRuleText
} = require('./billing-rules');

const CATEGORY_SCHEMA_VERSION = '2';
const seedCategorySettings = new Map(seedCategories.map((category) => [
  digits(category.cnpj),
  {
    billingMethod: category.billingMethod,
    whiteMartins: category.whiteMartins === true
  }
]));

const KEYS = Object.freeze({
  categories: 'faturamento:cobranca:categorias:v1',
  seed: 'faturamento:cobranca:categorias-seed:v1',
  categorySchema: 'faturamento:cobranca:categorias-schema:v1',
  pending: 'faturamento:cobranca:doccob-pendente:v1',
  completedEvents: 'faturamento:cobranca:eventos-concluidos:v1',
  dismissedIssues: 'faturamento:cobranca:pendencias-ocultas:v1',
  deliveries: 'faturamento:cobranca:envios:v1',
  deliveryReferences: 'faturamento:cobranca:referencias:v1',
  webhookEvents: 'faturamento:cobranca:webhook-eventos:v1',
  logs: 'faturamento:cobranca:logs:v1',
  invoiceBlocks: 'faturamento:cobranca:faturas-bloqueadas:v1',
  bankReconciliationFailures: 'faturamento:cobranca:falhas-liquidacao-automatica:v1',
  bankReconciliationIssues: 'faturamento:cobranca:pendencias-liquidacao:v1',
  bankReconciliationIgnored: 'faturamento:cobranca:liquidacao-ignorada:v1',
  recentIssuedCursor: 'faturamento:cobranca:cursor:emissoes-72h:v1',
  openInvoiceCursor: 'faturamento:cobranca:cursor:abertas:v1',
  reconciliationCursor: 'faturamento:cobranca:cursor:reconciliacao:v1',
  automaticBankScanCursor: 'faturamento:cobranca:cursor:liquidacao-automatica:v1',
  billingQueueCursor: 'faturamento:cobranca:cursor:fila:v1',
  processing: 'faturamento:cobranca:processamento:v1',
  paymentImports: 'faturamento:cobranca:importacao-pagamentos:v1',
  lastRun: 'faturamento:cobranca:ultima-execucao:v1'
});

const parseRecord = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const requiredCnpj = (value) => {
  const cnpj = digits(value);
  if (cnpj.length !== 14) {
    throw Object.assign(new Error('Informe um CNPJ com 14 números.'), { statusCode: 422 });
  }
  return cnpj;
};

const requiredText = (value, label, maximum) => {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) throw Object.assign(new Error(`${label} é obrigatório.`), { statusCode: 422 });
  return text.slice(0, maximum);
};

const requiredInvoiceId = (value) => {
  const invoiceId = String(value || '').trim().replace(/^0+(?=\d)/, '');
  if (!/^\d{1,20}$/.test(invoiceId) || Number(invoiceId) <= 0) {
    throw Object.assign(new Error('Informe o número da fatura.'), { statusCode: 422 });
  }
  return invoiceId;
};

const normalizedEmail = (value) => {
  const email = String(value || '').trim().toLocaleLowerCase('pt-BR');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw Object.assign(new Error('Informe um e-mail válido.'), { statusCode: 422 });
  }
  return email;
};

const normalizedCategory = (value) => {
  const cnpj = requiredCnpj(value?.cnpj);
  const name = requiredText(value?.name, 'Nome fantasia', 160);
  const suppliedBillingMethod = String(value?.billingMethod || '').trim();
  if (suppliedBillingMethod && !Object.values(BILLING_METHODS).includes(suppliedBillingMethod)) {
    throw Object.assign(new Error('Selecione uma forma de cobrança válida.'), { statusCode: 422 });
  }
  const billingMethod = suppliedBillingMethod || BILLING_METHODS.bankSlip;
  const whiteMartins = value?.whiteMartins === true;
  return {
    cnpj,
    name,
    billingMethod,
    whiteMartins,
    contacts: Array.isArray(value?.contacts)
      ? value.contacts.map((contact) => ({ ...contact, enabled: contact?.enabled !== false }))
      : []
  };
};

const normalizedContact = (cnpj, value) => {
  const email = normalizedEmail(value?.email);
  const names = normalizeContactNames({
    firstName: value?.firstName,
    lastName: value?.lastName,
    email
  });
  if (!names.firstName) {
    throw Object.assign(new Error('Primeiro nome é obrigatório.'), { statusCode: 422 });
  }
  return {
    id: String(value?.id || contactId(cnpj, email)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64),
    firstName: names.firstName.slice(0, 80),
    lastName: names.lastName.slice(0, 120),
    email,
    enabled: value?.enabled !== false
  };
};

const ensureContactSeed = async (command = redisCommand) => {
  const argumentsList = seedCategories.flatMap((category) => [
    category.cnpj,
    JSON.stringify(normalizedCategory(category))
  ]);
  const script = [
    "if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end",
    "if #ARGV > 0 then redis.call('HSET', KEYS[1], unpack(ARGV)) end",
    "redis.call('SET', KEYS[2], '1')",
    'return 1'
  ].join('\n');
  return command('EVAL', script, '2', KEYS.categories, KEYS.seed, ...argumentsList);
};

const historicalCategorySettings = (category) => {
  const seeded = seedCategorySettings.get(digits(category?.cnpj));
  if (seeded) return seeded;
  const name = normalizedRuleText(category?.name);
  const whiteMartins = name.includes('WHITE');
  const tedDoc = whiteMartins || name.includes('ELECNOR') || (
    /(?:^| )BL(?: |$)/.test(name) && name.includes('OTICA')
  );
  return {
    billingMethod: tedDoc ? BILLING_METHODS.tedDoc : BILLING_METHODS.bankSlip,
    whiteMartins
  };
};

const ensureCategorySchema = async (command = redisCommand) => {
  await ensureContactSeed(command);
  if (String(await command('GET', KEYS.categorySchema) || '') === CATEGORY_SCHEMA_VERSION) return 0;
  const flat = await command('HGETALL', KEYS.categories) || [];
  const migrations = [];
  for (let index = 0; index < flat.length; index += 2) {
    const cnpj = flat[index];
    const raw = flat[index + 1];
    const category = parseRecord(raw);
    if (!category) continue;
    const missingBillingMethod = !Object.values(BILLING_METHODS).includes(category.billingMethod);
    const missingWhiteMartins = typeof category.whiteMartins !== 'boolean';
    if (!missingBillingMethod && !missingWhiteMartins) continue;
    const historical = historicalCategorySettings(category);
    const migrated = {
      ...category,
      billingMethod: missingBillingMethod ? historical.billingMethod : category.billingMethod,
      whiteMartins: missingWhiteMartins ? historical.whiteMartins : category.whiteMartins
    };
    migrations.push(cnpj, raw, JSON.stringify(migrated));
  }
  const script = [
    "if redis.call('GET', KEYS[2]) == ARGV[1] then return 0 end",
    'local updated = 0',
    'for i = 2, #ARGV, 3 do',
    "  if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then",
    "    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 2])",
    '    updated = updated + 1',
    '  end',
    'end',
    "redis.call('SET', KEYS[2], ARGV[1])",
    'return updated'
  ].join('\n');
  return command(
    'EVAL',
    script,
    '2',
    KEYS.categories,
    KEYS.categorySchema,
    CATEGORY_SCHEMA_VERSION,
    ...migrations
  );
};

const listCategories = async (command = redisCommand) => {
  await ensureCategorySchema(command);
  const flat = await command('HGETALL', KEYS.categories) || [];
  const categories = [];
  for (let index = 0; index < flat.length; index += 2) {
    const category = parseRecord(flat[index + 1]);
    if (category) categories.push(normalizedCategory(category));
  }
  return categories.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
};

const getCategory = async (cnpj, command = redisCommand) => {
  await ensureCategorySchema(command);
  const normalizedCnpj = requiredCnpj(cnpj);
  const category = parseRecord(await command('HGET', KEYS.categories, normalizedCnpj));
  return category ? normalizedCategory(category) : null;
};

const saveCategory = async (input, command = redisCommand) => {
  await ensureContactSeed(command);
  const next = normalizedCategory(input);
  const current = await getCategory(next.cnpj, command);
  const category = { ...next, contacts: current?.contacts || [] };
  await command('HSET', KEYS.categories, category.cnpj, JSON.stringify(category));
  return category;
};

const deleteCategory = async (cnpj, command = redisCommand) => {
  await ensureContactSeed(command);
  return Number(await command('HDEL', KEYS.categories, requiredCnpj(cnpj))) > 0;
};

const saveContact = async (cnpj, input, command = redisCommand) => {
  const category = await getCategory(cnpj, command);
  if (!category) throw Object.assign(new Error('Empresa não encontrada.'), { statusCode: 404 });
  const contact = normalizedContact(category.cnpj, input);
  const contacts = category.contacts.filter((item) =>
    item.id !== contact.id && String(item.email).toLocaleLowerCase('pt-BR') !== contact.email
  );
  contacts.push(contact);
  category.contacts = contacts.sort((left, right) => left.firstName.localeCompare(right.firstName, 'pt-BR'));
  await command('HSET', KEYS.categories, category.cnpj, JSON.stringify(category));
  return { category, contact };
};

const mergeContacts = async (cnpj, inputs, command = redisCommand) => {
  const category = await getCategory(cnpj, command);
  if (!category) throw Object.assign(new Error('Empresa não encontrada.'), { statusCode: 404 });
  const knownEmails = new Set(category.contacts.map((contact) =>
    String(contact.email || '').trim().toLocaleLowerCase('pt-BR')));
  const added = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    let contact;
    try {
      contact = normalizedContact(category.cnpj, input);
    } catch {
      continue;
    }
    if (knownEmails.has(contact.email)) continue;
    knownEmails.add(contact.email);
    category.contacts.push(contact);
    added.push(contact);
  }
  if (added.length) {
    category.contacts.sort((left, right) => left.firstName.localeCompare(right.firstName, 'pt-BR'));
    await command('HSET', KEYS.categories, category.cnpj, JSON.stringify(category));
  }
  return { category, added };
};

const setContactEnabled = async (cnpj, id, enabled, command = redisCommand) => {
  const category = await getCategory(cnpj, command);
  if (!category) throw Object.assign(new Error('Empresa não encontrada.'), { statusCode: 404 });
  if (typeof enabled !== 'boolean') {
    throw Object.assign(new Error('Informe se o contato deve receber os envios.'), { statusCode: 422 });
  }
  const contactIdValue = requiredText(id, 'Contato', 64);
  const contact = category.contacts.find((item) => item.id === contactIdValue);
  if (!contact) throw Object.assign(new Error('Contato não encontrado.'), { statusCode: 404 });
  contact.enabled = enabled;
  await command('HSET', KEYS.categories, category.cnpj, JSON.stringify(category));
  return { category, contact };
};

const deleteContact = async (cnpj, id, command = redisCommand) => {
  const category = await getCategory(cnpj, command);
  if (!category) throw Object.assign(new Error('Empresa não encontrada.'), { statusCode: 404 });
  const contactIdValue = requiredText(id, 'Contato', 64);
  const contacts = category.contacts.filter((contact) => contact.id !== contactIdValue);
  if (contacts.length === category.contacts.length) return false;
  category.contacts = contacts;
  await command('HSET', KEYS.categories, category.cnpj, JSON.stringify(category));
  return true;
};

const listPending = async (command = redisCommand) => {
  const flat = await command('HGETALL', KEYS.pending) || [];
  const pending = [];
  for (let index = 0; index < flat.length; index += 2) {
    const record = parseRecord(flat[index + 1]);
    if (record) pending.push(record);
  }
  return pending.sort((left, right) => String(right.firstSeenAt).localeCompare(String(left.firstSeenAt)));
};

const savePending = (record, command = redisCommand) => command(
  'HSET',
  KEYS.pending,
  String(record.invoiceId),
  JSON.stringify(record)
);

const savePendingBatch = (records, command = redisCommand) => {
  const validRecords = (Array.isArray(records) ? records : [])
    .filter((record) => record?.invoiceId);
  if (!validRecords.length) return Promise.resolve(0);
  return command(
    'HSET',
    KEYS.pending,
    ...validRecords.flatMap((record) => [String(record.invoiceId), JSON.stringify(record)])
  );
};

const removePending = (invoiceId, command = redisCommand) =>
  command('HDEL', KEYS.pending, requiredInvoiceId(invoiceId));

const removePendingBatch = (invoiceIds, command = redisCommand) => {
  const normalizedIds = [...new Set((Array.isArray(invoiceIds) ? invoiceIds : [])
    .map((invoiceId) => requiredInvoiceId(invoiceId)))];
  if (!normalizedIds.length) return Promise.resolve(0);
  return command('HDEL', KEYS.pending, ...normalizedIds);
};

const completedEventField = (event, invoiceId) => {
  const normalizedEvent = requiredText(event, 'Evento', 48)
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9_]/g, '');
  return `${normalizedEvent}:${requiredInvoiceId(invoiceId)}`;
};

const getCompletedBillingEvents = async (items, command = redisCommand) => {
  const fields = [...new Set((Array.isArray(items) ? items : []).map((item) => (
    completedEventField(item.event, item.invoiceId)
  )))];
  if (!fields.length) return new Set();
  const values = await command('HMGET', KEYS.completedEvents, ...fields) || [];
  return new Set(fields.filter((_field, index) => Boolean(values[index])));
};

const markBillingEventCompleted = (event, invoiceId, record, command = redisCommand) => command(
  'HSET',
  KEYS.completedEvents,
  completedEventField(event, invoiceId),
  JSON.stringify(record)
);

const listDismissedIssues = async (command = redisCommand) => {
  const flat = await command('HGETALL', KEYS.dismissedIssues) || [];
  const dismissed = new Map();
  for (let index = 0; index < flat.length; index += 2) {
    dismissed.set(String(flat[index]), String(flat[index + 1] || ''));
  }
  return dismissed;
};

const dismissIssue = async (id, version = '', command = redisCommand) => {
  const issueId = requiredText(id, 'Pendência', 256);
  const issueVersion = String(version || '');
  await command('HSET', KEYS.dismissedIssues, issueId, issueVersion);
  return { id: issueId, version: issueVersion };
};

const deliveryField = (event, invoiceId, email) => [
  String(event || '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9_]/g, '').slice(0, 48),
  String(invoiceId || '').replace(/\D/g, ''),
  String(email || '').trim().toLocaleLowerCase('pt-BR')
].join(':');

const getDelivery = async (event, invoiceId, email, command = redisCommand) =>
  parseRecord(await command('HGET', KEYS.deliveries, deliveryField(event, invoiceId, email)));

const getJointDeliveries = async (invoiceIds, command = redisCommand) => {
  const ids = [...new Set((invoiceIds || []).map(requiredInvoiceId))];
  if (!ids.length) return new Map();
  const values = await command('HMGET', KEYS.deliveries,
    ...ids.map((id) => deliveryField('joint', id, '__company__'))) || [];
  return new Map(ids.map((id, index) => [id, parseRecord(values[index])]));
};

const claimDelivery = async (event, invoiceId, email, record, command = redisCommand) => Number(
  await command(
    'HSETNX',
    KEYS.deliveries,
    deliveryField(event, invoiceId, email),
    JSON.stringify(record)
  )
) === 1;

const RELEASE_DELIVERY_CLAIM_SCRIPT = `
  local current = redis.call('HGET', KEYS[1], ARGV[1])
  if not current then return 0 end
  local record = cjson.decode(current)
  if record.state ~= 'processing' or record.claimId ~= ARGV[2] then return 0 end
  return redis.call('HDEL', KEYS[1], ARGV[1])
`;

const releaseDeliveryClaim = async (event, invoiceId, email, claimId, command = redisCommand) => Number(
  await command(
    'EVAL', RELEASE_DELIVERY_CLAIM_SCRIPT, '1', KEYS.deliveries,
    deliveryField(event, invoiceId, email), String(claimId || '')
  )
) === 1;

const saveDelivery = (event, invoiceId, email, record, command = redisCommand) => command(
  'HSET',
  KEYS.deliveries,
  deliveryField(event, invoiceId, email),
  JSON.stringify(record)
);

const saveDeliveryReference = (reference, record, command = redisCommand) => command(
  'HSET',
  KEYS.deliveryReferences,
  String(reference),
  JSON.stringify(record)
);

const getDeliveryReference = async (reference, command = redisCommand) =>
  parseRecord(await command('HGET', KEYS.deliveryReferences, String(reference)));

const webhookEventKey = (eventId) => `${KEYS.webhookEvents}:${String(eventId)}`;

const claimWebhookEvent = async (eventId, command = redisCommand) => (
  await command(
    'SET',
    webhookEventKey(eventId),
    new Date().toISOString(),
    'NX',
    'EX',
    '604800'
  )
) === 'OK';

const releaseWebhookEvent = (eventId, command = redisCommand) => command(
  'DEL',
  webhookEventKey(eventId)
);

const addLog = async (record, command = redisCommand) => {
  const log = {
    id: record.id || randomUUID(),
    createdAt: record.createdAt || new Date().toISOString(),
    ...record
  };
  await command('ZADD', KEYS.logs, String(Date.parse(log.createdAt) || Date.now()), JSON.stringify(log));
  return log;
};

const resolveLog = async (id, note = '', command = redisCommand) => {
  const logId = requiredText(id, 'Log', 128);
  const values = await command('ZREVRANGE', KEYS.logs, '0', '999') || [];
  const selected = values
    .map((value) => parseRecord(value))
    .find((record) => record?.id === logId);
  if (!selected) return null;
  if (selected.status === 'resolved') return selected;

  const resolvedAt = new Date().toISOString();
  const resolutionNote = String(note || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  return addLog({
    ...selected,
    id: randomUUID(),
    createdAt: resolvedAt,
    status: 'resolved',
    previousStatus: selected.status || '',
    resolvedAt,
    resolvedLogId: selected.id,
    resolutionNote,
    message: resolutionNote || 'Ocorrência marcada como resolvida manualmente.'
  }, command);
};

const getInvoiceBlock = async (invoiceId, command = redisCommand) => {
  const normalizedId = requiredInvoiceId(invoiceId);
  const manual = parseRecord(await command('HGET', KEYS.invoiceBlocks, normalizedId));
  if (manual?.blocked) return manual;
  const [failed, ignored] = await Promise.all([
    command('SISMEMBER', KEYS.bankReconciliationFailures, normalizedId),
    command('SISMEMBER', KEYS.bankReconciliationIgnored, normalizedId)
  ]);
  return Number(failed) || Number(ignored)
    ? { invoiceId: normalizedId, blocked: true, reason: 'bank_reconciliation' } : null;
};

const getInvoiceBlocks = async (invoiceIds, command = redisCommand) => {
  const ids = [...new Set((invoiceIds || []).map(requiredInvoiceId))];
  if (!ids.length) return new Map();
  const [values, failures, ignored] = await Promise.all([
    command('HMGET', KEYS.invoiceBlocks, ...ids),
    command('SMEMBERS', KEYS.bankReconciliationFailures),
    command('SMEMBERS', KEYS.bankReconciliationIgnored)
  ]);
  const financialBlocks = new Set([...(failures || []), ...(ignored || [])].map(String));
  return new Map(ids.map((id, index) => [id,
    parseRecord(values?.[index]) || (financialBlocks.has(id)
      ? { invoiceId: id, blocked: true, reason: 'bank_reconciliation' } : null)]));
};

const setInvoiceBlocked = async (invoiceId, blocked, command = redisCommand) => {
  const normalizedId = requiredInvoiceId(invoiceId);
  if (typeof blocked !== 'boolean') {
    throw Object.assign(new Error('Informe se o envio da fatura deve ser bloqueado.'), { statusCode: 422 });
  }
  if (!blocked) {
    await command('HDEL', KEYS.invoiceBlocks, normalizedId);
    return { invoiceId: normalizedId, blocked: false };
  }
  const record = {
    invoiceId: normalizedId,
    blocked: true,
    blockedAt: new Date().toISOString()
  };
  await command('HSET', KEYS.invoiceBlocks, normalizedId, JSON.stringify(record));
  return record;
};

const listBlockedInvoiceIds = async (command = redisCommand) => {
  const [manual, bankFailures, ignored] = await Promise.all([
    command('HKEYS', KEYS.invoiceBlocks),
    command('SMEMBERS', KEYS.bankReconciliationFailures),
    command('SMEMBERS', KEYS.bankReconciliationIgnored)
  ]);
  return [...new Set([...(manual || []), ...(bankFailures || []), ...(ignored || [])].map(String))];
};

const listIgnoredBankReconciliationIds = async (command = redisCommand) =>
  (await command('SMEMBERS', KEYS.bankReconciliationIgnored) || []).map(String);

const listBankReconciliationIssues = async (command = redisCommand) => {
  const [flat, failures, ignored] = await Promise.all([
    command('HGETALL', KEYS.bankReconciliationIssues),
    command('SMEMBERS', KEYS.bankReconciliationFailures),
    command('SMEMBERS', KEYS.bankReconciliationIgnored)
  ]);
  const records = new Map();
  for (let index = 0; index < (flat || []).length; index += 2) {
    const invoiceId = String(flat[index]);
    const record = parseRecord(flat[index + 1]);
    if (record) records.set(invoiceId, record);
  }
  const failedIds = new Set((failures || []).map(String));
  const ignoredIds = new Set((ignored || []).map(String));
  return [...new Set([...records.keys(), ...failedIds, ...ignoredIds])]
    .map((invoiceId) => ({
      invoiceId,
      bank: String(records.get(invoiceId)?.bank || ''),
      message: String(records.get(invoiceId)?.message || 'Falha anterior sem detalhes salvos.'),
      httpStatus: Number(records.get(invoiceId)?.httpStatus) || null,
      firstSeenAt: records.get(invoiceId)?.firstSeenAt || null,
      lastSeenAt: records.get(invoiceId)?.lastSeenAt || null,
      ignoredAt: records.get(invoiceId)?.ignoredAt || null,
      status: ignoredIds.has(invoiceId) ? 'ignored' : 'active'
    }))
    .filter((issue) => issue.status === 'ignored' || failedIds.has(issue.invoiceId))
    .sort((left, right) => String(right.lastSeenAt || '').localeCompare(String(left.lastSeenAt || '')) ||
      left.invoiceId.localeCompare(right.invoiceId, undefined, { numeric: true }));
};

const updateBankReconciliationFailures = async ({ failed = [], cleared = [] } = {}, command = redisCommand) => {
  const failedIds = [...new Set(failed.map((item) => requiredInvoiceId(item?.invoiceId || item)))];
  const clearedIds = [...new Set(cleared.map(requiredInvoiceId))];
  if (failedIds.some((id) => clearedIds.includes(id))) {
    throw new Error('Uma fatura não pode falhar e ser liberada no mesmo lote.');
  }
  // Registrar falhas primeiro: se a persistência falhar, o agendador não
  // avança o cursor nem inicia os e-mails.
  if (failedIds.length) await command('SADD', KEYS.bankReconciliationFailures, ...failedIds);
  for (const item of failed) {
    if (!item || typeof item !== 'object') continue;
    const invoiceId = requiredInvoiceId(item.invoiceId);
    const previous = parseRecord(await command('HGET', KEYS.bankReconciliationIssues, invoiceId), {});
    const now = new Date().toISOString();
    await command('HSET', KEYS.bankReconciliationIssues, invoiceId, JSON.stringify({
      invoiceId,
      bank: String(item.bank || previous.bank || '').slice(0, 32),
      message: String(item.message || previous.message || 'Conciliação não concluída.').slice(0, 300),
      httpStatus: Number.isInteger(item.httpStatus) ? item.httpStatus : null,
      firstSeenAt: previous.firstSeenAt || now,
      lastSeenAt: now
    }));
  }
  if (clearedIds.length) await command('SREM', KEYS.bankReconciliationFailures, ...clearedIds);
  if (clearedIds.length) await command('HDEL', KEYS.bankReconciliationIssues, ...clearedIds);
};

const ignoreBankReconciliationIssue = async (invoiceId, command = redisCommand) => {
  const id = requiredInvoiceId(invoiceId);
  const [failed, previousValue] = await Promise.all([
    command('SISMEMBER', KEYS.bankReconciliationFailures, id),
    command('HGET', KEYS.bankReconciliationIssues, id)
  ]);
  if (!Number(failed) && !previousValue) {
    throw Object.assign(new Error('Pendência de liquidação não encontrada.'), { statusCode: 404, expose: true });
  }
  const previous = parseRecord(previousValue, {});
  const now = new Date().toISOString();
  // Ignorar retira a fatura somente da fila de liquidação. A falha permanece
  // como bloqueio de cobrança enquanto o estado bancário não for confirmado.
  await command('SADD', KEYS.bankReconciliationIgnored, id);
  await command('HSET', KEYS.bankReconciliationIssues, id, JSON.stringify({
    ...previous,
    invoiceId: id,
    message: previous.message || 'Falha anterior sem detalhes salvos.',
    firstSeenAt: previous.firstSeenAt || now,
    lastSeenAt: previous.lastSeenAt || now,
    ignoredAt: now
  }));
  return { invoiceId: id, status: 'ignored' };
};

const resumeBankReconciliationIssue = async (invoiceId, command = redisCommand) => {
  const id = requiredInvoiceId(invoiceId);
  if (!Number(await command('SISMEMBER', KEYS.bankReconciliationIgnored, id))) {
    throw Object.assign(new Error('A fatura não está ignorada na liquidação.'), { statusCode: 404, expose: true });
  }
  const previous = parseRecord(await command('HGET', KEYS.bankReconciliationIssues, id), {});
  // Continua bloqueada para cobrança até uma conferência sem erro.
  await command('SADD', KEYS.bankReconciliationFailures, id);
  await command('SREM', KEYS.bankReconciliationIgnored, id);
  await command('HSET', KEYS.bankReconciliationIssues, id, JSON.stringify({
    ...previous,
    invoiceId: id,
    ignoredAt: null
  }));
  return { invoiceId: id, status: 'active' };
};

const saoPauloDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const filteredLogs = async ({ invoiceId = '', date = '', cnpj = '' } = {}, command = redisCommand) => {
  const values = await command('ZREVRANGE', KEYS.logs, '0', '999') || [];
  const normalizedInvoice = String(invoiceId || '').replace(/\D/g, '');
  const normalizedCnpj = digits(cnpj);
  const normalizedDate = String(date || '').slice(0, 10);
  const records = values.map((value) => parseRecord(value)).filter(Boolean);
  const resolvedLogIds = new Set(records
    .filter((record) => record.status === 'resolved' && record.resolvedLogId)
    .map((record) => String(record.resolvedLogId)));
  const matching = records
    .filter((record) => !resolvedLogIds.has(String(record.id || '')))
    .filter(Boolean)
    .filter((record) => !normalizedInvoice || digits(record.invoiceId) === normalizedInvoice)
    .filter((record) => !normalizedCnpj || digits(record.clientCnpj) === normalizedCnpj)
    .filter((record) => !normalizedDate || saoPauloDate(record.createdAt) === normalizedDate);
  const seenReferences = new Set();
  return matching.filter((record) => {
    const reference = String(record.clientReference || '');
    if (!reference) return true;
    const key = record.jointBilling ? `${reference}:${record.email || ''}` : reference;
    if (seenReferences.has(key)) return false;
    seenReferences.add(key);
    return true;
  });
};

const listLogs = async ({ invoiceId = '', date = '', cnpj = '', page = 1, limit = 10 } = {}, command = redisCommand) => {
  const records = await filteredLogs({ invoiceId, date, cnpj }, command);
  const pageSize = Math.max(1, Math.min(Number(limit) || 10, 50));
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(Number(page) || 1, totalPages));
  const start = (currentPage - 1) * pageSize;
  return {
    logs: records.slice(start, start + pageSize),
    total,
    pagination: {
      page: currentPage,
      pageSize,
      totalPages,
      hasPrevious: currentPage > 1,
      hasNext: currentPage < totalPages
    }
  };
};

const getRecentIssuedCursor = async (command = redisCommand) => {
  const value = parseRecord(await command('GET', KEYS.recentIssuedCursor), {});
  return {
    from: String(value.from || ''),
    skip: Math.max(0, Number(value.skip) || 0)
  };
};

const saveRecentIssuedCursor = (cursor, command = redisCommand) => command(
  'SET', KEYS.recentIssuedCursor, JSON.stringify({
    from: String(cursor.from || ''),
    skip: Math.max(0, Number(cursor.skip) || 0)
  })
);

const getOpenInvoiceCursor = async (command = redisCommand) =>
  Math.max(0, Number(await command('GET', KEYS.openInvoiceCursor)) || 0);

const saveOpenInvoiceCursor = (cursor, command = redisCommand) =>
  command('SET', KEYS.openInvoiceCursor, String(Math.max(0, Number(cursor) || 0)));

const getReconciliationCursor = async (command = redisCommand) =>
  Math.max(0, Number(await command('GET', KEYS.reconciliationCursor)) || 0);

const saveReconciliationCursor = (cursor, command = redisCommand) =>
  command('SET', KEYS.reconciliationCursor, String(Math.max(0, Number(cursor) || 0)));

const getAutomaticBankScanCursor = async (command = redisCommand) => {
  const value = String(await command('GET', KEYS.automaticBankScanCursor) || '');
  return /^\d{1,20}$/.test(value) ? value : '';
};

const saveAutomaticBankScanCursor = (cursor, command = redisCommand) => {
  const value = String(cursor || '');
  if (value && !/^\d{1,20}$/.test(value)) {
    throw new Error('Cursor de liquidação automática inválido.');
  }
  return command('SET', KEYS.automaticBankScanCursor, value);
};

const getBillingQueueCursor = async (command = redisCommand) =>
  Math.max(0, Number(await command('GET', KEYS.billingQueueCursor)) || 0);

const saveBillingQueueCursor = (cursor, command = redisCommand) =>
  command('SET', KEYS.billingQueueCursor, String(Math.max(0, Number(cursor) || 0)));

const claimProcessingRun = async (runId, command = redisCommand) => (
  await command('SET', KEYS.processing, String(runId), 'NX', 'EX', '90')
) === 'OK';

const releaseProcessingRun = (runId, command = redisCommand) => command(
  'EVAL',
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
  '1',
  KEYS.processing,
  String(runId)
);

const paymentImportKey = (importId) => {
  const normalized = String(importId || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(normalized)) {
    throw Object.assign(new Error('Identificador da importação inválido.'), { statusCode: 422 });
  }
  return `${KEYS.paymentImports}:${normalized}`;
};

const paymentApprovalKey = (importId, invoiceId) =>
  `${paymentImportKey(importId)}:aprovacao:${requiredInvoiceId(invoiceId)}`;

const paymentImportResultsKey = (importId) => `${paymentImportKey(importId)}:resultados`;

const savePaymentImport = async (record, command = redisCommand) => {
  const importId = String(record?.id || '').trim().toLowerCase();
  await command('SET', paymentImportKey(importId), JSON.stringify(record), 'EX', '86400');
  return record;
};

const paymentImportWithResults = (record, flat = []) => {
  if (!record) return null;
  const results = new Map();
  for (let index = 0; index < flat.length; index += 2) {
    const result = parseRecord(flat[index + 1]);
    if (result) results.set(String(flat[index]), result);
  }
  let updatedAt = String(record.updatedAt || '');
  record.candidates = (record.candidates || []).map((candidate) => {
    const result = results.get(String(candidate.invoiceId));
    if (!result) return candidate;
    const status = result.status === 'busy' ? 'error' : result.status;
    updatedAt = [updatedAt, String(result.updatedAt || '')].sort().at(-1);
    return {
      ...candidate,
      status,
      eligible: !['liquidated', 'already_settled'].includes(status),
      approvedAt: result.approvedAt || candidate.approvedAt,
      liquidationIds: result.liquidationIds || candidate.liquidationIds,
      reason: status === 'error' ? String(result.message || '') : ''
    };
  });
  record.summary.eligibleInvoices = record.candidates.filter((candidate) =>
    candidate.eligible && candidate.status === 'ready').length;
  record.summary.eligibleAmount = record.candidates.filter((candidate) =>
    candidate.eligible && candidate.status === 'ready')
    .reduce((total, candidate) => total + candidate.importedAmount, 0);
  if (updatedAt) record.updatedAt = updatedAt;
  return record;
};

const getPaymentImport = async (importId, command = redisCommand) => {
  const record = parseRecord(await command('GET', paymentImportKey(importId)));
  if (!record) return null;
  const flat = await command('HGETALL', paymentImportResultsKey(importId)) || [];
  return paymentImportWithResults(record, flat);
};

const SAVE_PAYMENT_IMPORT_RESULT_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
  local previous = redis.call('HGET', KEYS[2], ARGV[1])
  if previous then
    local old = cjson.decode(previous)
    local next = cjson.decode(ARGV[2])
    if old.status == 'liquidated' and next.status ~= 'liquidated' then return 2 end
    if old.status == 'already_settled' and next.status ~= 'liquidated' then return 2 end
  end
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
  redis.call('EXPIREAT', KEYS[2], ARGV[3])
  return 1
`;

const savePaymentImportResult = async (importId, result, expiresAt, command = redisCommand) => {
  const invoiceId = requiredInvoiceId(result?.invoiceId);
  const expiresAtSeconds = Math.floor(Date.parse(expiresAt) / 1000);
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0) {
    throw Object.assign(new Error('Prazo da importação inválido.'), { statusCode: 422 });
  }
  const saved = await command(
    'EVAL', SAVE_PAYMENT_IMPORT_RESULT_SCRIPT, '2',
    paymentImportKey(importId), paymentImportResultsKey(importId),
    invoiceId, JSON.stringify({ ...result, updatedAt: new Date().toISOString() }),
    String(expiresAtSeconds)
  );
  if (Number(saved) === 0) {
    throw Object.assign(new Error('A importação expirou ou não foi encontrada.'), { statusCode: 404 });
  }
  return saved;
};

const claimPaymentApproval = async (importId, invoiceId, command = redisCommand) => (
  await command('SET', paymentApprovalKey(importId, invoiceId), new Date().toISOString(), 'NX', 'EX', '90')
) === 'OK';

const releasePaymentApproval = (importId, invoiceId, command = redisCommand) =>
  command('DEL', paymentApprovalKey(importId, invoiceId));

const saveLastRun = (record, command = redisCommand) => command(
  'SET',
  KEYS.lastRun,
  JSON.stringify(record)
);

const getLastRun = async (command = redisCommand) =>
  parseRecord(await command('GET', KEYS.lastRun));

module.exports = {
  KEYS,
  parseRecord,
  requiredCnpj,
  requiredInvoiceId,
  normalizedEmail,
  normalizedCategory,
  normalizedContact,
  ensureContactSeed,
  historicalCategorySettings,
  ensureCategorySchema,
  listCategories,
  getCategory,
  saveCategory,
  deleteCategory,
  saveContact,
  mergeContacts,
  setContactEnabled,
  deleteContact,
  listPending,
  savePending,
  savePendingBatch,
  removePending,
  removePendingBatch,
  completedEventField,
  getCompletedBillingEvents,
  markBillingEventCompleted,
  listDismissedIssues,
  dismissIssue,
  deliveryField,
  getDelivery,
  getJointDeliveries,
  claimDelivery,
  releaseDeliveryClaim,
  saveDelivery,
  saveDeliveryReference,
  getDeliveryReference,
  claimWebhookEvent,
  releaseWebhookEvent,
  addLog,
  resolveLog,
  getInvoiceBlock,
  getInvoiceBlocks,
  setInvoiceBlocked,
  listBlockedInvoiceIds,
  listIgnoredBankReconciliationIds,
  listBankReconciliationIssues,
  updateBankReconciliationFailures,
  ignoreBankReconciliationIssue,
  resumeBankReconciliationIssue,
  saoPauloDate,
  filteredLogs,
  listLogs,
  getRecentIssuedCursor,
  saveRecentIssuedCursor,
  getOpenInvoiceCursor,
  saveOpenInvoiceCursor,
  getReconciliationCursor,
  saveReconciliationCursor,
  getAutomaticBankScanCursor,
  saveAutomaticBankScanCursor,
  getBillingQueueCursor,
  saveBillingQueueCursor,
  claimProcessingRun,
  releaseProcessingRun,
  paymentImportKey,
  savePaymentImport,
  getPaymentImport,
  paymentImportWithResults,
  savePaymentImportResult,
  claimPaymentApproval,
  releasePaymentApproval,
  saveLastRun,
  getLastRun
};
