const { createHash } = require('node:crypto');

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 15;
const memoryStore = new Map();

const redisConfig = () => ({
  url: String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, ''),
  token: String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '')
});

const redisCommand = async (...args) => {
  const { url, token } = redisConfig();
  if (!url || !token) return null;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `Redis ${response.status}`);
  return payload.result;
};

const keyFor = (address) => {
  const digest = createHash('sha256')
    .update(String(address))
    .digest('hex');
  return `faturamento:login:${digest}`;
};

const memoryAttempt = (key, now = Date.now()) => {
  const current = memoryStore.get(key);
  if (!current || current.expiresAt <= now) {
    memoryStore.set(key, { count: 1, expiresAt: now + WINDOW_SECONDS * 1000 });
    return 1;
  }
  current.count += 1;
  return current.count;
};

const registerAttempt = async (address) => {
  const key = keyFor(address);
  try {
    const count = await redisCommand(
      'EVAL',
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return n",
      '1',
      key,
      String(WINDOW_SECONDS)
    );
    if (count !== null) return Number(count);
  } catch (error) {
    console.warn('[faturamento:rate-limit]', error.message);
  }
  return memoryAttempt(key);
};

const clearAttempts = async (address) => {
  const key = keyFor(address);
  memoryStore.delete(key);
  try {
    await redisCommand('DEL', key);
  } catch (error) {
    console.warn('[faturamento:rate-limit]', error.message);
  }
};

module.exports = {
  WINDOW_SECONDS,
  MAX_ATTEMPTS,
  registerAttempt,
  clearAttempts
};
