const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const safeEqual = (left, right) => {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
};

const parseCookies = (header) => Object.fromEntries(
  String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return [part, ''];
      const name = part.slice(0, separator);
      const value = part.slice(separator + 1);
      try {
        return [decodeURIComponent(name), decodeURIComponent(value)];
      } catch {
        return [name, value];
      }
    })
);

const createSessionManager = ({
  cookieName,
  userEnv,
  passwordEnv,
  secretEnv,
  defaultUser,
  notConfiguredMessage,
  ttlSeconds = 8 * 60 * 60,
  minimumPasswordLength = 1
}) => {
  const configuredUser = () => String(process.env[userEnv] || defaultUser);
  const configuredPassword = () => String(process.env[passwordEnv] || '');
  const sessionSecret = () => String(process.env[secretEnv] || '');
  const isConfigured = () =>
    configuredPassword().length >= minimumPasswordLength && sessionSecret().length >= 32;

  const assertConfigured = () => {
    if (!isConfigured()) {
      throw Object.assign(new Error(notConfiguredMessage), { statusCode: 503 });
    }
  };

  const validCredentials = (username, password) => {
    assertConfigured();
    return safeEqual(username, configuredUser()) && safeEqual(password, configuredPassword());
  };

  const sign = (payload) =>
    createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

  const createSessionToken = (username = configuredUser(), now = Date.now()) => {
    assertConfigured();
    const payload = Buffer.from(JSON.stringify({
      sub: username,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + ttlSeconds,
      nonce: randomBytes(12).toString('base64url')
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };

  const verifySessionToken = (token, now = Date.now()) => {
    if (!isConfigured() || typeof token !== 'string') return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return null;
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

  const sessionFromRequest = (req) =>
    verifySessionToken(parseCookies(req.headers.cookie)[cookieName]);

  const sessionCookie = (token, secure = true) => [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${ttlSeconds}`,
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');

  const clearSessionCookie = (secure = true) => [
    `${cookieName}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');

  return {
    COOKIE_NAME: cookieName,
    SESSION_TTL_SECONDS: ttlSeconds,
    isConfigured,
    assertConfigured,
    validCredentials,
    createSessionToken,
    verifySessionToken,
    sessionFromRequest,
    sessionCookie,
    clearSessionCookie
  };
};

module.exports = {
  safeEqual,
  parseCookies,
  createSessionManager
};
