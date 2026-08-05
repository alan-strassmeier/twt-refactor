const {
  isConfigured: redisAvailable,
  command
} = require('../shared/redis');

const memoryResults = new Map();
const memoryClaims = new Map();

const resultKey = (key) => `nfe:minuta:result:${key}`;
const claimKey = (key) => `nfe:minuta:claim:${key}`;

const memoryCleanup = () => {
  const now = Date.now();
  for (const [key, item] of memoryResults) {
    if (item.expiresAt <= now) memoryResults.delete(key);
  }
  for (const [key, expiresAt] of memoryClaims) {
    if (expiresAt <= now) memoryClaims.delete(key);
  }
};

const getResult = async (key) => {
  if (redisAvailable()) {
    const remote = await command('GET', resultKey(key));
    if (remote) {
      try {
        return JSON.parse(remote);
      } catch {
        return null;
      }
    }
  }
  memoryCleanup();
  return memoryResults.get(key)?.value || null;
};

const claim = async (key) => {
  if (redisAvailable()) {
    return await command('SET', claimKey(key), '1', 'NX', 'EX', 600) === 'OK';
  }
  memoryCleanup();
  if (memoryClaims.has(key)) return false;
  memoryClaims.set(key, Date.now() + 600_000);
  return true;
};

const release = async (key) => {
  if (redisAvailable()) await command('DEL', claimKey(key));
  else memoryClaims.delete(key);
};

const saveResult = async (key, value) => {
  const serialized = JSON.stringify(value);
  memoryResults.set(key, {
    value,
    expiresAt: Date.now() + 7_776_000_000
  });
  if (redisAvailable()) {
    try {
      await command('SET', resultKey(key), serialized, 'EX', 7_776_000);
      return true;
    } catch (error) {
      // A minuta já existe neste ponto. Preservamos o sucesso na instância
      // atual e deixamos a trava remota expirar, evitando uma repetição imediata.
      console.error('[nfe:deduplication]', error);
      return false;
    }
  }
  return true;
};

const runOnce = async (key, operation) => {
  const existing = await getResult(key);
  if (existing) return { ...existing, alreadyProcessed: true };
  if (!await claim(key)) {
    const error = new Error('Esta NF-e já está sendo processada. Aguarde alguns instantes.');
    error.statusCode = 409;
    throw error;
  }
  let releaseClaim = true;
  try {
    const secondCheck = await getResult(key);
    if (secondCheck) return { ...secondCheck, alreadyProcessed: true };
    const result = await operation();
    releaseClaim = await saveResult(key, result);
    return result;
  } finally {
    if (releaseClaim) await release(key).catch(() => {});
  }
};

const resetMemoryForTests = () => {
  memoryResults.clear();
  memoryClaims.clear();
};

module.exports = {
  runOnce,
  resetMemoryForTests
};
