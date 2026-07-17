const { createHmac, timingSafeEqual } = require('node:crypto');
const { waitUntil } = require('@vercel/functions');
const { processWebhook } = require('../server/whatsapp/processor');

const MAX_BODY_SIZE = 2 * 1024 * 1024;

const send = (res, status, body, contentType = 'text/plain; charset=utf-8') => {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
};

const queryValue = (req, name) => {
  if (req.query && req.query[name] !== undefined) return String(req.query[name]);
  return new URL(req.url || '/', 'https://webhook.local').searchParams.get(name) || '';
};

const readRawBody = async (req) => {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') {
    // Algumas versões do runtime da Vercel disponibilizam o JSON já interpretado.
    // Os webhooks da Meta usam JSON compacto; reconstruímos sem alterar a ordem das propriedades.
    return Buffer.from(JSON.stringify(req.body));
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) throw Object.assign(new Error('Payload muito grande.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const verifySignature = (rawBody, signature, appSecret) => {
  if (!appSecret || !signature?.startsWith('sha256=')) return false;
  const received = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
};

const handler = async (req, res) => {
  if (req.method === 'GET') {
    const mode = queryValue(req, 'hub.mode');
    const token = queryValue(req, 'hub.verify_token');
    const challenge = queryValue(req, 'hub.challenge');
    if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      send(res, 200, challenge);
      return;
    }
    send(res, 403, 'Token de verificação inválido.');
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    send(res, 405, 'Método não permitido.');
    return;
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = String(req.headers['x-hub-signature-256'] || '');
    if (!verifySignature(rawBody, signature, process.env.WHATSAPP_APP_SECRET || '')) {
      send(res, 401, 'Assinatura inválida.');
      return;
    }
    const payload = JSON.parse(rawBody.toString('utf8'));
    waitUntil(processWebhook(payload).catch((error) => console.error('[whatsapp:webhook]', error)));
    send(res, 200, 'EVENT_RECEIVED');
  } catch (error) {
    console.error('[whatsapp:request]', error);
    send(res, Number(error.statusCode) || 400, 'Requisição inválida.');
  }
};

module.exports = handler;
module.exports.config = {
  api: { bodyParser: false },
  maxDuration: 60
};
module.exports.verifySignature = verifySignature;
