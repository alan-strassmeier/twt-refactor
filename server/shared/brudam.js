const BASE_URL = String(
  process.env.BRUDAM_API_URL || 'https://twt.brudam.com.br/api/v1'
).replace(/\/$/, '');
const DEFAULT_TIMEOUT_MS = 20000;

let cachedToken = '';
let cachedTokenExpiresAt = 0;

const httpError = (message, statusCode) =>
  Object.assign(new Error(message), { statusCode });

const unavailableError = (message, cause) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'BRUDAM_UNAVAILABLE';
  error.statusCode = 502;
  return error;
};

const request = async (path, options = {}) => {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...fetchOptions,
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : {
          status: 0,
          message: (await response.text()).slice(0, 1000) || 'Resposta inválida da Brudam.'
        };
    return { response, payload };
  } catch (error) {
    if (error?.code === 'BRUDAM_UNAVAILABLE') throw error;
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw unavailableError(
      `Brudam temporariamente indisponível: ${timedOut ? 'tempo limite excedido' : 'falha de comunicação'}.`,
      error
    );
  } finally {
    clearTimeout(timeout);
  }
};

const tokenExpiration = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000;
  } catch {
    return Date.now() + 240000;
  }
};

const getAccessToken = async (forceRefresh = false) => {
  if (!forceRefresh && cachedToken && Date.now() < cachedTokenExpiresAt - 30000) {
    return cachedToken;
  }

  const usuario = String(process.env.BRUDAM_API_USER || '');
  const senha = String(process.env.BRUDAM_API_PASSWORD || '');
  if (!/^[A-Fa-f0-9]{32}$/.test(usuario) || !/^[A-Fa-f0-9]{64}$/.test(senha)) {
    throw httpError('Integração Brudam não configurada.', 503);
  }

  const { response, payload } = await request('/acesso/auth/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  const token = payload?.data?.access_key;
  if (!response.ok || typeof token !== 'string' || !token) {
    throw unavailableError(payload?.message || 'Falha de autenticação na Brudam.');
  }

  cachedToken = token;
  cachedTokenExpiresAt = tokenExpiration(token);
  return token;
};

const clearAccessToken = () => {
  cachedToken = '';
  cachedTokenExpiresAt = 0;
};

const authorizedRequest = async (path, options = {}) => {
  let token = await getAccessToken();
  let result = await request(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (result.response.status !== 401) return result;

  clearAccessToken();
  token = await getAccessToken(true);
  result = await request(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  return result;
};

const authenticatedGet = (path, options = {}) => authorizedRequest(path, {
  ...options,
  method: 'GET',
  headers: { Accept: 'application/json', ...(options.headers || {}) }
});

module.exports = {
  BASE_URL,
  DEFAULT_TIMEOUT_MS,
  request,
  getAccessToken,
  authorizedRequest,
  authenticatedGet,
  clearAccessToken,
  unavailableError
};
