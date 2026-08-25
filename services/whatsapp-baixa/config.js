'use strict';

const { booleanEnvironment, allowedSenders } = require('../../server/whatsapp/runtime');

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} não configurado.`);
  return value;
};

const integer = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = String(process.env[name] ?? '').trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return value;
};

const explicitBoolean = (name) => {
  if (!String(process.env[name] ?? '').trim()) {
    throw new Error(`${name} deve ser definido explicitamente como true ou false.`);
  }
  return booleanEnvironment(name);
};

const validateDatabase = () => {
  if (String(process.env.DATABASE_URL || '').trim()) return;
  for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) required(name);
};

const loadConfig = () => {
  validateDatabase();
  const dryRun = explicitBoolean('WHATSAPP_DRY_RUN');
  const enforceAllowlist = explicitBoolean('WHATSAPP_ENFORCE_ALLOWLIST');
  explicitBoolean('WHATSAPP_SEND_REPLIES');
  const allowAllSenders = booleanEnvironment('WHATSAPP_ALLOW_ALL_SENDERS', false);
  const senders = allowedSenders();
  if (!enforceAllowlist) {
    throw new Error('O serviço próprio exige WHATSAPP_ENFORCE_ALLOWLIST=true.');
  }
  if (!allowAllSenders && senders.size === 0) {
    throw new Error('Defina WHATSAPP_ALLOWED_SENDERS ou WHATSAPP_ALLOW_ALL_SENDERS=true.');
  }
  if (String(process.env.WHATSAPP_STATE_STORE || '').trim().toLowerCase() !== 'postgres') {
    throw new Error('O serviço próprio exige WHATSAPP_STATE_STORE=postgres.');
  }
  if (String(process.env.WHATSAPP_IMAGE_STORE || '').trim().toLowerCase() !== 'filesystem') {
    throw new Error('O serviço próprio exige WHATSAPP_IMAGE_STORE=filesystem.');
  }
  required('WHATSAPP_IMAGE_STORAGE_PATH');
  const imageRetentionDays = integer('WHATSAPP_IMAGE_RETENTION_DAYS', 30, {
    min: 30,
    max: 30
  });

  required('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = required('WHATSAPP_PHONE_NUMBER_ID');
  const receiverFlowId = required('WHATSAPP_RECEIVER_FLOW_ID');
  const deliveryTimeFlowId = required('WHATSAPP_DELIVERY_TIME_FLOW_ID');
  const brudamUser = required('BRUDAM_API_USER');
  const brudamPassword = required('BRUDAM_API_PASSWORD');
  if (!/^\d+$/.test(phoneNumberId) || !/^\d+$/.test(receiverFlowId) || !/^\d+$/.test(deliveryTimeFlowId)) {
    throw new Error('IDs da Meta devem conter somente dígitos.');
  }
  if (!/^[A-Fa-f0-9]{32}$/.test(brudamUser) || !/^[A-Fa-f0-9]{64}$/.test(brudamPassword)) {
    throw new Error('Credenciais Brudam devem ter os formatos de 32 e 64 caracteres hexadecimais.');
  }

  const workerLeaseSeconds = integer('WHATSAPP_WORKER_LEASE_SECONDS', 1200, {
    min: 900,
    max: 86400
  });

  return {
    port: integer('WHATSAPP_SERVICE_PORT', Number(process.env.PORT) || 3000, {
      min: 1,
      max: 65535
    }),
    publicPath: String(process.env.WHATSAPP_PUBLIC_PATH || '/api/whatsapp').trim(),
    verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
    appSecret: required('WHATSAPP_APP_SECRET'),
    dryRun,
    enforceAllowlist,
    allowAllSenders,
    allowedSenderCount: senders.size,
    pollMilliseconds: integer('WHATSAPP_WORKER_POLL_MS', 1000, { min: 100, max: 60000 }),
    maxAttempts: integer('WHATSAPP_WORKER_MAX_ATTEMPTS', 8, { min: 1, max: 100 }),
    workerLeaseSeconds,
    imageRetentionDays,
    imageMinFreeBytes: integer('WHATSAPP_IMAGE_MIN_FREE_BYTES', 1073741824, {
      min: 104857600,
      max: 107374182400
    }),
    maxBodyBytes: integer('WHATSAPP_MAX_WEBHOOK_BYTES', 2 * 1024 * 1024, {
      min: 1024,
      max: 20 * 1024 * 1024
    })
  };
};

module.exports = { loadConfig, required, integer, explicitBoolean };
