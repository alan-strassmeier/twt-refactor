const DEFAULT_TIMEOUT_MS = 10000;

const config = () => ({
  url: String(
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || ''
  ).replace(/\/$/, ''),
  token: String(
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''
  )
});

const isConfigured = () => {
  const { url, token } = config();
  return Boolean(url && token);
};

const command = async (...args) => {
  const { url, token } = config();
  if (!url || !token) {
    throw Object.assign(new Error(
      'Redis não configurado. Defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.'
    ), { statusCode: 503 });
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`Falha no Redis: ${payload.error || response.status}`);
  }
  return payload.result;
};

const commandIfConfigured = async (...args) =>
  isConfigured() ? command(...args) : null;

module.exports = {
  config,
  isConfigured,
  command,
  commandIfConfigured
};
