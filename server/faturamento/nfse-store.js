const { redisCommand } = require('./boleto-store');

const recordKeyFor = (invoiceId) => `faturamento:nfse:twt:fatura:${invoiceId}`;
const sequenceKeyFor = ({ environment, issuerCnpj, series }) =>
  `faturamento:nfse:dps:${environment}:${issuerCnpj}:${series}:sequencial`;
const agentQueueKeyFor = (environment) =>
  `faturamento:nfse:agent:${environment}:fila`;
const RECORD_KEY_PREFIX = 'faturamento:nfse:twt:fatura:';

const parseRecord = (value) => {
  if (!value) return null;
  try {
    const record = JSON.parse(value);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
};

const getNfseRecord = async (invoiceId, command = redisCommand) =>
  parseRecord(await command('GET', recordKeyFor(invoiceId)));

const claimNfse = async (invoiceId, record, command = redisCommand) => {
  const result = await command(
    'SET',
    recordKeyFor(invoiceId),
    JSON.stringify(record),
    'NX',
    'EX',
    '900'
  );
  return result === 'OK';
};

const saveNfseRecord = (invoiceId, record, command = redisCommand) =>
  command('SET', recordKeyFor(invoiceId), JSON.stringify(record));

const releaseNfseClaim = (invoiceId, command = redisCommand) =>
  command('DEL', recordKeyFor(invoiceId));

const reserveDpsNumber = async (config, command = redisCommand) => {
  const script = [
    "if redis.call('EXISTS', KEYS[1]) == 0 then",
    "  redis.call('SET', KEYS[1], ARGV[1])",
    'end',
    "return redis.call('INCR', KEYS[1])"
  ].join('\n');
  const result = await command(
    'EVAL',
    script,
    '1',
    sequenceKeyFor(config),
    String(config.initialNumber)
  );
  const number = Number(result);
  if (!Number.isSafeInteger(number) || number < 1 || number >= 1e15) {
    throw Object.assign(new Error('Não foi possível reservar o número da DPS.'), {
      statusCode: 503,
      expose: true
    });
  }
  return number;
};

const enqueueNfseJob = async (record, options = {}) => {
  const command = options.command || redisCommand;
  const score = Number(options.availableAt || Date.now());
  await command(
    'ZADD',
    agentQueueKeyFor(record.environment),
    String(Number.isFinite(score) ? score : Date.now()),
    String(record.invoiceId)
  );
};

const claimNextNfseJob = async ({ environment, agentId, leaseToken, now, leaseMs },
  command = redisCommand) => {
  const script = [
    "local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 20)",
    'for _, invoiceId in ipairs(members) do',
    "  local key = ARGV[2] .. invoiceId",
    "  local raw = redis.call('GET', key)",
    '  if not raw then',
    "    redis.call('ZREM', KEYS[1], invoiceId)",
    '  else',
    '    local ok, record = pcall(cjson.decode, raw)',
    '    if not ok then',
    "      redis.call('ZREM', KEYS[1], invoiceId)",
    '    else',
    "      local state = tostring(record['state'] or '')",
    "      local leaseExpires = tonumber(record['leaseExpiresAtEpoch'] or 0)",
    "      local eligible = state == 'queued' or (state == 'agent_processing' and leaseExpires <= tonumber(ARGV[1]))",
    '      if eligible then',
    "        record['state'] = 'agent_processing'",
    "        record['agentId'] = ARGV[3]",
    "        record['leaseToken'] = ARGV[4]",
    "        record['leaseExpiresAtEpoch'] = tonumber(ARGV[5])",
    "        record['leaseExpiresAt'] = ARGV[6]",
    "        record['attempts'] = tonumber(record['attempts'] or 0) + 1",
    "        redis.call('SET', key, cjson.encode(record))",
    "        redis.call('ZADD', KEYS[1], ARGV[5], invoiceId)",
    '        return cjson.encode(record)',
    '      elseif state ~= \'queued\' and state ~= \'agent_processing\' then',
    "        redis.call('ZREM', KEYS[1], invoiceId)",
    '      end',
    '    end',
    '  end',
    'end',
    'return nil'
  ].join('\n');
  const leaseExpiresAtEpoch = now + leaseMs;
  const value = await command(
    'EVAL',
    script,
    '1',
    agentQueueKeyFor(environment),
    String(now),
    RECORD_KEY_PREFIX,
    String(agentId),
    String(leaseToken),
    String(leaseExpiresAtEpoch),
    new Date(leaseExpiresAtEpoch).toISOString()
  );
  return parseRecord(value);
};

const assertNfseJobLease = async ({ invoiceId, leaseToken, agentId }, command = redisCommand) => {
  const record = await getNfseRecord(invoiceId, command);
  if (!record || record.state !== 'agent_processing' ||
      record.leaseToken !== leaseToken || record.agentId !== agentId) {
    throw Object.assign(new Error('O trabalho não existe ou a concessão do agente expirou.'), {
      statusCode: 409,
      expose: true
    });
  }
  return record;
};

const removeNfseJobFromQueue = (record, command = redisCommand) =>
  command('ZREM', agentQueueKeyFor(record.environment), String(record.invoiceId));

module.exports = {
  recordKeyFor,
  sequenceKeyFor,
  parseRecord,
  getNfseRecord,
  claimNfse,
  saveNfseRecord,
  releaseNfseClaim,
  reserveDpsNumber,
  agentQueueKeyFor,
  enqueueNfseJob,
  claimNextNfseJob,
  assertNfseJobLease,
  removeNfseJobFromQueue
};
