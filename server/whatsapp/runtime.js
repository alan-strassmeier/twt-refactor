'use strict';

const booleanEnvironment = (name, fallback = false) => {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} deve ser true ou false.`);
};

const normalizedPhone = (value) => String(value || '').replace(/\D/g, '');

const allowedSenders = () => new Set(
  String(process.env.WHATSAPP_ALLOWED_SENDERS || '')
    .split(',')
    .map(normalizedPhone)
    .filter(Boolean)
);

const isDryRun = () => booleanEnvironment('WHATSAPP_DRY_RUN', false);

const isSenderAllowed = (senderPhone) => {
  if (!booleanEnvironment('WHATSAPP_ENFORCE_ALLOWLIST', false)) return true;
  if (booleanEnvironment('WHATSAPP_ALLOW_ALL_SENDERS', false)) return true;
  return allowedSenders().has(normalizedPhone(senderPhone));
};

const redactedPhone = (value) => {
  const phone = normalizedPhone(value);
  if (!phone) return 'desconhecido';
  return `***${phone.slice(-4)}`;
};

module.exports = {
  booleanEnvironment,
  normalizedPhone,
  allowedSenders,
  isDryRun,
  isSenderAllowed,
  redactedPhone
};
