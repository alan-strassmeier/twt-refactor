'use strict';

const BASE_URL = (process.env.BRUDAM_API_URL || 'https://twt.brudam.com.br/api/v1').replace(/\/$/, '');
const TIMEOUT_MS = 20000;

let cachedToken = '';
let cachedTokenExpiresAt = 0;

const request = async (path, options = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { status: 0, message: 'Resposta inválida da Brudam.' };
  return { response, payload };
};

const tokenExpiration = (token) => {
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - encoded.length % 4) % 4);
    return Number(JSON.parse(Buffer.from(encoded + padding, 'base64').toString('utf8')).exp) * 1000;
  } catch {
    return Date.now() + 240000;
  }
};

const authenticate = async (force = false) => {
  if (!force && cachedToken && Date.now() < cachedTokenExpiresAt - 30000) return cachedToken;

  const usuario = process.env.BRUDAM_API_USER || '';
  const senha = process.env.BRUDAM_API_PASSWORD || '';
  if (!/^[A-Fa-f0-9]{32}$/.test(usuario) || !/^[A-Fa-f0-9]{64}$/.test(senha)) {
    const error = new Error('Integração com a Brudam não configurada.');
    error.statusCode = 503;
    throw error;
  }

  const { response, payload } = await request('/acesso/auth/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  const token = payload?.data?.access_key;
  if (!response.ok || typeof token !== 'string' || !token) {
    throw new Error('Não foi possível autenticar na Brudam.');
  }

  cachedToken = token;
  cachedTokenExpiresAt = tokenExpiration(token);
  return token;
};

const authorizedRequest = async (path) => {
  let token = await authenticate();
  let result = await request(path, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
  if (result.response.status !== 401) return result;

  cachedToken = '';
  cachedTokenExpiresAt = 0;
  token = await authenticate(true);
  return request(path, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
};

const fetchCollection = async (id) => {
  const { response, payload } = await authorizedRequest(
    `/operacional/consulta/coleta/${encodeURIComponent(id)}`
  );
  if (!response.ok || Number(payload?.status) !== 1) {
    const error = new Error(payload?.message || 'Coleta não encontrada.');
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }
  return payload;
};

module.exports = { fetchCollection };
