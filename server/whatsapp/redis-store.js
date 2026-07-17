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

const pendingKey = (phone) => `whatsapp:pending:${phone}`;
const messageKey = (messageId) => `whatsapp:message:${messageId}`;

const savePendingDelivery = (phone, delivery) =>
  command('SET', pendingKey(phone), JSON.stringify(delivery), 'EX', 1800);

const getPendingDelivery = async (phone) => {
  const value = await command('GET', pendingKey(phone));
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    await command('DEL', pendingKey(phone));
    return null;
  }
};

const completePendingDelivery = (phone, imageMessageId, textMessageId) => command(
  'EVAL',
  "redis.call('DEL', KEYS[1]); redis.call('SET', KEYS[2], 'done', 'EX', 7776000); redis.call('SET', KEYS[3], 'done', 'EX', 7776000); return 1",
  '3',
  pendingKey(phone),
  messageKey(imageMessageId),
  messageKey(textMessageId)
);

module.exports = {
  claimMessage,
  markMessageDone,
  releaseMessage,
  saveLocation,
  takeLocation,
  savePendingDelivery,
  getPendingDelivery,
  completePendingDelivery
};
