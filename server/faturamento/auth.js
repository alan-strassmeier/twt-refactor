const { createHmac, createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const COOKIE_NAME = 'twt_faturamento_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

const sessionSecret = () => String(process.env.FATURAMENTO_SESSION_SECRET || '');
const configuredUser = () => String(process.env.FATURAMENTO_ADMIN_USER || 'admin');
const configuredPassword = () => String(process.env.FATURAMENTO_ADMIN_PASSWORD || '');

const isConfigured = () =>
  configuredPassword().length >= 10 &&
  sessionSecret().length >= 32;

const safeEqual = (left, right) => {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
};

const validCredentials = (username, password) =>
  isConfigured() &&
  safeEqual(username, configuredUser()) &&
  safeEqual(password, configuredPassword());

const encode = (value) => Buffer.from(value).toString('base64url');
const sign = (payload) => createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

const createSessionToken = (username = configuredUser(), now = Date.now()) => {
  if (!isConfigured()) throw new Error('Área de faturamento não configurada.');
  const payload = encode(JSON.stringify({
    sub: username,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
    nonce: randomBytes(12).toString('base64url')
  }));
  return `${payload}.${sign(payload)}`;
};

const parseCookies = (header) => Object.fromEntries(
  String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return [part, ''];
      const value = part.slice(separator + 1);
      try {
        return [part.slice(0, separator), decodeURIComponent(value)];
      } catch {
        return [part.slice(0, separator), value];
      }
    })
);

const verifySessionToken = (token, now = Date.now()) => {
  if (!isConfigured() || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  if (!safeEqual(signature, sign(payload))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const current = Math.floor(now / 1000);
    if (
      data.sub !== configuredUser() ||
      !Number.isInteger(data.iat) ||
      !Number.isInteger(data.exp) ||
      data.iat > current + 60 ||
      data.exp <= current
    ) return null;
    return data;
  } catch {
    return null;
  }
};

const sessionFromRequest = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
};

const sessionCookie = (token, secure = true) => [
  `${COOKIE_NAME}=${encodeURIComponent(token)}`,
  'Path=/',
  `Max-Age=${SESSION_TTL_SECONDS}`,
  'HttpOnly',
  'SameSite=Strict',
  secure ? 'Secure' : ''
].filter(Boolean).join('; ');

const clearSessionCookie = (secure = true) => [
  `${COOKIE_NAME}=`,
  'Path=/',
  'Max-Age=0',
  'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  'HttpOnly',
  'SameSite=Strict',
  secure ? 'Secure' : ''
].filter(Boolean).join('; ');

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  isConfigured,
  validCredentials,
  createSessionToken,
  verifySessionToken,
  sessionFromRequest,
  sessionCookie,
  clearSessionCookie
};
