const redisConfig = () => ({
  url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, ''),
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''
});

const command = async (...args) => {
  const { url, token } = redisConfig();
  if (!url || !token) {
    throw new Error('Redis não configurado. Defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.');
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
    throw new Error(`Falha no Redis: ${payload.error || response.status}`);
  }
  return payload.result;
};

const claimMessage = async (messageId) => {
  const result = await command('SET', `whatsapp:message:${messageId}`, 'processing', 'NX', 'EX', 900);
  return result === 'OK';
};

const markMessageDone = (messageId) =>
  command('SET', `whatsapp:message:${messageId}`, 'done', 'EX', 7776000);

const releaseMessage = (messageId) => command('DEL', `whatsapp:message:${messageId}`);

const saveLocation = (phone, location) =>
  command('SET', `whatsapp:location:${phone}`, JSON.stringify(location), 'EX', 1800);

const takeLocation = async (phone) => {
  const value = await command('GETDEL', `whatsapp:location:${phone}`);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

module.exports = { claimMessage, markMessageDone, releaseMessage, saveLocation, takeLocation };
