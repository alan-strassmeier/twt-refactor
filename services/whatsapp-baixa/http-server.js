'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { verifySignature } = require('../../server/whatsapp/signature');

const respond = (response, statusCode, body, extraHeaders = {}) => {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
};

const readBody = async (request, maxBodyBytes) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Payload muito grande.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const createRequestHandler = ({
  enqueueWebhook,
  isReady,
  verifyToken,
  appSecret,
  publicPath = '/api/whatsapp',
  maxBodyBytes = 2 * 1024 * 1024
}) => async (request, response) => {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/health/live') {
    respond(response, 200, 'ok');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health/ready') {
    const ready = await isReady();
    respond(response, ready ? 200 : 503, ready ? 'ready' : 'not ready');
    return;
  }
  if (url.pathname !== publicPath) {
    respond(response, 404, 'Não encontrado.');
    return;
  }

  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode') || '';
    const token = url.searchParams.get('hub.verify_token') || '';
    const challenge = url.searchParams.get('hub.challenge') || '';
    if (mode === 'subscribe' && token && token === verifyToken) {
      respond(response, 200, challenge);
    } else {
      respond(response, 403, 'Token de verificação inválido.');
    }
    return;
  }

  if (request.method !== 'POST') {
    respond(response, 405, 'Método não permitido.', { Allow: 'GET, POST' });
    return;
  }

  try {
    const rawBody = await readBody(request, maxBodyBytes);
    const signature = request.headers['x-hub-signature-256'] || '';
    if (!verifySignature(rawBody, signature, appSecret)) {
      respond(response, 401, 'Assinatura inválida.');
      return;
    }
    const payload = JSON.parse(rawBody.toString('utf8'));
    const eventKey = createHash('sha256').update(rawBody).digest('hex');
    await enqueueWebhook(eventKey, payload);
    respond(response, 200, 'EVENT_RECEIVED');
  } catch (error) {
    const statusCode = error.statusCode || (error instanceof SyntaxError ? 400 : 503);
    console.error('[whatsapp:http]', { statusCode, message: error.message });
    respond(response, statusCode, statusCode === 413
      ? 'Payload muito grande.'
      : statusCode === 400
        ? 'Requisição inválida.'
        : 'Serviço temporariamente indisponível.');
  }
};

const createWebhookServer = (options) =>
  http.createServer(createRequestHandler(options));

module.exports = { createWebhookServer, createRequestHandler, readBody };
