const { createHash } = require('node:crypto');
const { commandIfConfigured } = require('../shared/redis');

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 15;
const memoryStore = new Map();

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
    const count = await commandIfConfigured(
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
    await commandIfConfigured('DEL', key);
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
