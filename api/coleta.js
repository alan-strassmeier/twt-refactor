'use strict';

const { timingSafeEqual } = require('node:crypto');
const { fetchCollection } = require('../server/coleta/brudam');
const { normalizeCollection, buildCollectionMessage } = require('../server/coleta/message');

const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const rateLimitStore = new Map();

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
};

const allowedOrigin = (origin) => {
  const configured = String(process.env.COLETA_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length === 0 || configured.includes(origin);
};

const setCors = (req, res) => {
  const origin = String(req.headers.origin || '');
  if (!allowedOrigin(origin)) return false;
  const hasConfiguredOrigins = Boolean(String(process.env.COLETA_ALLOWED_ORIGINS || '').trim());
  res.setHeader('Access-Control-Allow-Origin', hasConfiguredOrigins ? origin : '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');
  return true;
};

const validToken = (authorization) => {
  const configured = String(process.env.COLETA_EXTENSION_TOKEN || '');
  const received = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (configured.length < 32 || received.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(configured));
};

const clientAddress = (req) => String(req.headers['x-forwarded-for'] || '')
  .split(',')[0]
  .trim() || req.socket?.remoteAddress || 'unknown';

const withinRateLimit = (req) => {
  const now = Date.now();
  const address = clientAddress(req);
  const current = rateLimitStore.get(address);
  if (!current || current.expiresAt <= now) {
    rateLimitStore.set(address, { count: 1, expiresAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT_MAX_REQUESTS;
};

module.exports = async (req, res) => {
  const corsAllowed = setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = corsAllowed ? 204 : 403;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    sendJson(res, 405, { status: 0, message: 'Método não permitido.' });
    return;
  }
  if (!corsAllowed) {
    console.warn('[collection:cors]', { origin: String(req.headers.origin || '(missing)') });
    sendJson(res, 403, { status: 0, message: 'Origem não autorizada.' });
    return;
  }
  if (!validToken(req.headers.authorization)) {
    sendJson(res, 401, { status: 0, message: 'Acesso não autorizado.' });
    return;
  }
  if (!withinRateLimit(req)) {
    res.setHeader('Retry-After', '60');
    sendJson(res, 429, { status: 0, message: 'Muitas consultas. Aguarde um minuto.' });
    return;
  }

  const id = String(req.query?.id || '').trim();
  if (!/^\d{1,10}$/.test(id)) {
    sendJson(res, 422, { status: 0, message: 'Número da coleta inválido.' });
    return;
  }

  try {
    const payload = await fetchCollection(id);
    const collection = normalizeCollection(payload);
    if (!collection.id) collection.id = id;
    sendJson(res, 200, {
      status: 1,
      data: { collection, message: buildCollectionMessage(collection) }
    });
  } catch (error) {
    const statusCode = Number(error.statusCode) ||
      (['TimeoutError', 'AbortError'].includes(error.name) ? 504 : 502);
    if (statusCode >= 500) console.error('[collection]', error);
    sendJson(res, statusCode, {
      status: 0,
      message: statusCode >= 500 && statusCode !== 503
        ? 'Consulta de coleta temporariamente indisponível.'
        : error.message
    });
  }
};

module.exports.allowedOrigin = allowedOrigin;
module.exports.validToken = validToken;
