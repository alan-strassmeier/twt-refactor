const { randomUUID } = require('node:crypto');
const seedCategories = require('./cobranca-contacts-seed.json');
const { redisCommand } = require('./boleto-store');
const {
  contactId,
  digits,
  normalizeContactNames
} = require('./cobranca-contact-import');

const KEYS = Object.freeze({
  categories: 'faturamento:cobranca:categorias:v1',
  seed: 'faturamento:cobranca:categorias-seed:v1',
  pending: 'faturamento:cobranca:doccob-pendente:v1',
  deliveries: 'faturamento:cobranca:envios:v1',
  deliveryReferences: 'faturamento:cobranca:referencias:v1',
  webhookEvents: 'faturamento:cobranca:webhook-eventos:v1',
  logs: 'faturamento:cobranca:logs:v1',
  overdueCursor: 'faturamento:cobranca:cursor:vencidas:v1',
  processing: 'faturamento:cobranca:processamento:v1',
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

const normalizedEmail = (value) => {
  const email = String(value || '').trim().toLocaleLowerCase('pt-BR');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw Object.assign(new Error('Informe um e-mail válido.'), { statusCode: 422 });
  }
  return email;
};

const normalizedCategory = (value) => ({
  cnpj: requiredCnpj(value?.cnpj),
  name: requiredText(value?.name, 'Nome fantasia', 160),
  contacts: Array.isArray(value?.contacts)
    ? value.contacts.map((contact) => ({ ...contact, enabled: contact?.enabled !== false }))
    : []
});

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

const listCategories = async (command = redisCommand) => {
  await ensureContactSeed(command);
  const flat = await command('HGETALL', KEYS.categories) || [];
  const categories = [];
  for (let index = 0; index < flat.length; index += 2) {
    const category = parseRecord(flat[index + 1]);
    if (category) categories.push(normalizedCategory(category));
  }
  return categories.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
};

const getCategory = async (cnpj, command = redisCommand) => {
  await ensureContactSeed(command);
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

const removePending = (invoiceId, command = redisCommand) =>
  command('HDEL', KEYS.pending, String(invoiceId));

const deliveryField = (event, invoiceId, email) => [
  String(event || '').replace(/[^a-z_]/g, ''),
  String(invoiceId || '').replace(/\D/g, ''),
  String(email || '').trim().toLocaleLowerCase('pt-BR')
].join(':');

const getDelivery = async (event, invoiceId, email, command = redisCommand) =>
  parseRecord(await command('HGET', KEYS.deliveries, deliveryField(event, invoiceId, email)));

const claimDelivery = async (event, invoiceId, email, record, command = redisCommand) => Number(
  await command(
    'HSETNX',
    KEYS.deliveries,
    deliveryField(event, invoiceId, email),
    JSON.stringify(record)
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
  const matching = values
    .map((value) => parseRecord(value))
    .filter(Boolean)
    .filter((record) => !normalizedInvoice || digits(record.invoiceId) === normalizedInvoice)
    .filter((record) => !normalizedCnpj || digits(record.clientCnpj) === normalizedCnpj)
    .filter((record) => !normalizedDate || saoPauloDate(record.createdAt) === normalizedDate);
  const seenReferences = new Set();
  return matching.filter((record) => {
    const reference = String(record.clientReference || '');
    if (!reference) return true;
    if (seenReferences.has(reference)) return false;
    seenReferences.add(reference);
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

const getOverdueCursor = async (command = redisCommand) =>
  Math.max(0, Number(await command('GET', KEYS.overdueCursor)) || 0);

const saveOverdueCursor = (cursor, command = redisCommand) =>
  command('SET', KEYS.overdueCursor, String(Math.max(0, Number(cursor) || 0)));

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
  normalizedEmail,
  normalizedCategory,
  normalizedContact,
  ensureContactSeed,
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
  removePending,
  deliveryField,
  getDelivery,
  claimDelivery,
  saveDelivery,
  saveDeliveryReference,
  getDeliveryReference,
  claimWebhookEvent,
  releaseWebhookEvent,
  addLog,
  saoPauloDate,
  filteredLogs,
  listLogs,
  getOverdueCursor,
  saveOverdueCursor,
  claimProcessingRun,
  releaseProcessingRun,
  saveLastRun,
  getLastRun
};
