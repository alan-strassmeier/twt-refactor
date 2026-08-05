const { createSessionManager } = require('../shared/session');

const manager = createSessionManager({
  cookieName: 'twt_nfe_session',
  userEnv: 'NFE_PORTAL_USER',
  passwordEnv: 'NFE_PORTAL_PASSWORD',
  secretEnv: 'NFE_SESSION_SECRET',
  defaultUser: 'twt',
  notConfiguredMessage: 'Acesso à área de NF-e ainda não foi configurado.'
});

const secureRequest = (req) =>
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

module.exports = {
  COOKIE_NAME: manager.COOKIE_NAME,
  SESSION_TTL_SECONDS: manager.SESSION_TTL_SECONDS,
  assertConfigured: manager.assertConfigured,
  authenticateCredentials: manager.validCredentials,
  createSessionToken: (now = Date.now()) => manager.createSessionToken(undefined, now),
  verifySessionToken: (token, now = Date.now()) => Boolean(manager.verifySessionToken(token, now)),
  sessionFromRequest: (req) => Boolean(manager.sessionFromRequest(req)),
  sessionCookie: (req, token) => manager.sessionCookie(token, secureRequest(req)),
  expiredSessionCookie: (req) => manager.clearSessionCookie(secureRequest(req))
};
