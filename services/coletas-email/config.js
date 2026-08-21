'use strict';

const path = require('node:path');

const required = (name, fallback = '') => {
  const value = String(process.env[name] || fallback).trim();
  if (!value) throw new Error(`${name} não configurado.`);
  return value;
};

const list = (name, fallback = '') => String(process.env[name] || fallback)
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const number = (name, fallback) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} inválido.`);
  return value;
};

const loadConfig = () => {
  const root = path.resolve(__dirname);
  const imapUser = required('COLETAS_IMAP_USER');
  const imapPassword = required('COLETAS_IMAP_PASSWORD');
  return {
    imap: {
      host: required('COLETAS_IMAP_HOST', 'imappro.zoho.com'),
      port: number('COLETAS_IMAP_PORT', 993),
      secure: true,
      auth: { user: imapUser, pass: imapPassword },
      logger: false
    },
    mailbox: required('COLETAS_IMAP_MAILBOX', 'INBOX'),
    pollIntervalMs: number('COLETAS_POLL_INTERVAL_SECONDS', 30) * 1000,
    processExisting: String(process.env.COLETAS_PROCESS_EXISTING || 'false').toLowerCase() === 'true',
    contactsFile: path.resolve(process.env.COLETAS_CONTACTS_FILE || path.join(root, 'contacts.json')),
    stateFile: path.resolve(process.env.COLETAS_STATE_FILE || path.join(root, 'data', 'state.json')),
    internalDomains: list('COLETAS_INTERNAL_DOMAINS', 'twt.com.br'),
    allowedSenders: list('COLETAS_ALLOWED_SENDERS', 'twt@twt.com.br'),
    maxPdfBytes: number('COLETAS_MAX_PDF_BYTES', 10 * 1024 * 1024),
    maxAttempts: number('COLETAS_MAX_ATTEMPTS', 3),
    whatsapp: {
      accessToken: required('WHATSAPP_ACCESS_TOKEN'),
      phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
      graphVersion: required('WHATSAPP_GRAPH_VERSION', 'v25.0')
    },
    smtp: {
      host: required('COLETAS_SMTP_HOST', 'smtppro.zoho.com'),
      port: number('COLETAS_SMTP_PORT', 465),
      secure: number('COLETAS_SMTP_PORT', 465) === 465,
      user: required('COLETAS_SMTP_USER', imapUser),
      password: required('COLETAS_SMTP_PASSWORD', imapPassword),
      from: required('COLETAS_ERROR_FROM', imapUser),
      to: required('COLETAS_ERROR_TO', 'twt@twt.com.br')
    }
  };
};

module.exports = { loadConfig };
