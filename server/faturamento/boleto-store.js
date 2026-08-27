const redisConfig = () => ({
  url: String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '')
    .replace(/\/$/, ''),
  token: String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '')
});

const redisCommand = async (...args) => {
  const { url, token } = redisConfig();
  if (!url || !token) {
    throw Object.assign(
      new Error('Redis obrigatório para impedir boletos duplicados.'),
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
    throw Object.assign(new Error('Falha no controle de duplicidade do boleto.'), {
      statusCode: 503,
      expose: true
    });
  }
  return payload.result;
};

const keyFor = (invoiceId) => `faturamento:boleto:twt:fatura:${invoiceId}`;

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
  keyFor,
  parseRecord,
  getBankSlipRecord,
  claimBankSlip,
  saveBankSlipRecord,
  releaseBankSlipClaim
};
