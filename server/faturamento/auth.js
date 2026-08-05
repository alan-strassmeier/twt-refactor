const { createSessionManager } = require('../shared/session');

module.exports = createSessionManager({
  cookieName: 'twt_faturamento_session',
  userEnv: 'FATURAMENTO_ADMIN_USER',
  passwordEnv: 'FATURAMENTO_ADMIN_PASSWORD',
  secretEnv: 'FATURAMENTO_SESSION_SECRET',
  defaultUser: 'admin',
  notConfiguredMessage: 'Área de faturamento não configurada.',
  minimumPasswordLength: 10
});
