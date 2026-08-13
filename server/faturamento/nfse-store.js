const { redisCommand } = require('./boleto-store');

const LEGACY_RECORD_KEY_PREFIX = 'faturamento:nfse:twt:fatura:';
const normalizeEnvironment = (value) => {
  const environment = String(value || 'homologation').trim().toLowerCase();
  if (!['homologation', 'production'].includes(environment)) {
    throw new Error('Ambiente da NFS-e inválido para armazenamento.');
  }
  return environment;
};
const recordKeyPrefixFor = (environment) =>
  `faturamento:nfse:${normalizeEnvironment(environment)}:twt:fatura:`;
const recordKeyFor = (invoiceId, environment = 'homologation') =>
  `${recordKeyPrefixFor(environment)}${invoiceId}`;
const legacyRecordKeyFor = (invoiceId) => `${LEGACY_RECORD_KEY_PREFIX}${invoiceId}`;
const sequenceKeyFor = ({ environment, issuerCnpj, series }) =>
  `faturamento:nfse:dps:${environment}:${issuerCnpj}:${series}:sequencial`;
const agentQueueKeyFor = (environment) =>
  `faturamento:nfse:agent:${environment}:fila`;

const parseRecord = (value) => {
  if (!value) return null;
  try {
    const record = JSON.parse(value);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
};

const getNfseRecord = async (invoiceId, environment = 'homologation', command = redisCommand) => {
  if (typeof environment === 'function') {
    command = environment;
    environment = 'homologation';
  }
  const normalizedEnvironment = normalizeEnvironment(environment);
  const key = recordKeyFor(invoiceId, normalizedEnvironment);
  const current = parseRecord(await command('GET', key));
  if (current) return current;

  // Registros criados antes do isolamento por ambiente ficam disponíveis apenas
  // no ambiente em que foram emitidos. Ausência do campo significa homologação,
  // que era o padrão seguro da versão anterior.
  const legacy = parseRecord(await command('GET', legacyRecordKeyFor(invoiceId)));
  if (!legacy) return null;
  const legacyEnvironment = normalizeEnvironment(legacy.environment || 'homologation');
  if (legacyEnvironment !== normalizedEnvironment) return null;
  const migrated = { ...legacy, environment: legacyEnvironment };
  await command('SET', key, JSON.stringify(migrated), 'NX');
  return parseRecord(await command('GET', key)) || migrated;
};

const claimNfse = async (invoiceId, record, command = redisCommand) => {
  const environment = normalizeEnvironment(record?.environment);
  const result = await command(
    'SET',
    recordKeyFor(invoiceId, environment),
    JSON.stringify({ ...record, environment }),
    'NX',
    'EX',
    '900'
  );
  return result === 'OK';
};

const saveNfseRecord = (invoiceId, record, command = redisCommand) => {
  const environment = normalizeEnvironment(record?.environment);
  return command(
    'SET',
    recordKeyFor(invoiceId, environment),
    JSON.stringify({ ...record, environment })
  );
};

const releaseNfseClaim = (invoiceId, environment = 'homologation', command = redisCommand) => {
  if (typeof environment === 'function') {
    command = environment;
    environment = 'homologation';
  }
  return command('DEL', recordKeyFor(invoiceId, environment));
};

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
    "    local legacyRaw = redis.call('GET', ARGV[3] .. invoiceId)",
    '    if legacyRaw then',
    '      local legacyOk, legacyRecord = pcall(cjson.decode, legacyRaw)',
    "      local legacyEnvironment = legacyOk and tostring(legacyRecord['environment'] or 'homologation') or ''",
    '      if legacyOk and legacyEnvironment == ARGV[4] then',
    "        legacyRecord['environment'] = ARGV[4]",
    '        redis.call(\'SET\', key, cjson.encode(legacyRecord), \'NX\')',
    "        raw = redis.call('GET', key)",
    '      end',
    '    end',
    '  end',
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
    "        record['agentId'] = ARGV[5]",
    "        record['leaseToken'] = ARGV[6]",
    "        record['leaseExpiresAtEpoch'] = tonumber(ARGV[7])",
    "        record['leaseExpiresAt'] = ARGV[8]",
    "        record['attempts'] = tonumber(record['attempts'] or 0) + 1",
    "        redis.call('SET', key, cjson.encode(record))",
    "        redis.call('ZADD', KEYS[1], ARGV[7], invoiceId)",
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
    recordKeyPrefixFor(environment),
    LEGACY_RECORD_KEY_PREFIX,
    normalizeEnvironment(environment),
    String(agentId),
    String(leaseToken),
    String(leaseExpiresAtEpoch),
    new Date(leaseExpiresAtEpoch).toISOString()
  );
  return parseRecord(value);
};

const assertNfseJobLease = async ({ invoiceId, leaseToken, agentId, environment },
  command = redisCommand) => {
  const record = await getNfseRecord(invoiceId, environment, command);
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
  normalizeEnvironment,
  recordKeyPrefixFor,
  recordKeyFor,
  legacyRecordKeyFor,
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
