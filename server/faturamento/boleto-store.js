const redisConfig = () => ({
  url: String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '')
    .replace(/\/$/, ''),
  token: String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '')
});

const redisCommand = async (...args) => {
  const { url, token } = redisConfig();
  if (!url || !token) {
    throw Object.assign(
      new Error('Redis obrigatório para o controle seguro do faturamento.'),
      { statusCode: 503, expose: true }
    );
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw Object.assign(new Error('Falha ao acessar o controle financeiro no Redis.'), {
      statusCode: 503,
      expose: true
    });
  }
  return payload.result;
};

const KEY_PREFIX = 'faturamento:boleto:twt:fatura:';
const keyFor = (invoiceId) => `${KEY_PREFIX}${invoiceId}`;

const parseRecord = (value) => {
  if (!value) return null;
  try {
    const record = JSON.parse(value);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
};

const getBankSlipRecord = async (invoiceId, command = redisCommand) =>
  parseRecord(await command('GET', keyFor(invoiceId)));

const getBankSlipRecords = async (invoiceIds, command = redisCommand) => {
  const ids = [...new Set((Array.isArray(invoiceIds) ? invoiceIds : [])
    .map((invoiceId) => String(invoiceId || '').replace(/\D/g, ''))
    .filter(Boolean))];
  if (!ids.length) return new Map();
  const values = await command('MGET', ...ids.map(keyFor)) || [];
  return new Map(ids.map((invoiceId, index) => [invoiceId, parseRecord(values[index])]));
};

const listBankSlipRecords = async (command = redisCommand, options = {}) => {
  const count = Math.max(10, Math.min(Number(options.count) || 100, 500));
  const maxIterations = Math.max(1, Math.min(Number(options.maxIterations) || 20, 100));
  const keys = [];
  let cursor = '0';
  let iterations = 0;
  do {
    const result = await command('SCAN', cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', String(count));
    cursor = String(result?.[0] || '0');
    if (Array.isArray(result?.[1])) keys.push(...result[1]);
    iterations += 1;
  } while (cursor !== '0' && iterations < maxIterations);
  const uniqueKeys = [...new Set(keys)].sort();
  if (!uniqueKeys.length) return [];
  const values = await command('MGET', ...uniqueKeys) || [];
  return uniqueKeys.map((key, index) => {
    const record = parseRecord(values[index]);
    return record ? { ...record, invoiceId: String(record.invoiceId || key.slice(KEY_PREFIX.length)) } : null;
  }).filter(Boolean);
};

const claimBankSlip = async (invoiceId, record, command = redisCommand) => {
  const result = await command(
    'SET',
    keyFor(invoiceId),
    JSON.stringify(record),
    'NX',
    'EX',
    '86400'
  );
  return result === 'OK';
};

const saveBankSlipRecord = (invoiceId, record, command = redisCommand) =>
  command('SET', keyFor(invoiceId), JSON.stringify(record));

const releaseBankSlipClaim = (invoiceId, command = redisCommand) =>
  command('DEL', keyFor(invoiceId));

module.exports = {
  redisCommand,
  KEY_PREFIX,
  keyFor,
  parseRecord,
  getBankSlipRecord,
  getBankSlipRecords,
  listBankSlipRecords,
  claimBankSlip,
  saveBankSlipRecord,
  releaseBankSlipClaim
};
