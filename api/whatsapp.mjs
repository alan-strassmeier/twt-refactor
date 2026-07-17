import { createRequire } from 'node:module';
import { waitUntil } from '@vercel/functions';

const require = createRequire(import.meta.url);
const { processWebhook } = require('../server/whatsapp/processor');
const { verifySignature } = require('../server/whatsapp/signature');

const MAX_BODY_SIZE = 2 * 1024 * 1024;

const send = (body, status = 200) => new Response(body, {
  status,
  headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  }
});

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const mode = url.searchParams.get('hub.mode') || '';
      const token = url.searchParams.get('hub.verify_token') || '';
      const challenge = url.searchParams.get('hub.challenge') || '';
      if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        return send(challenge);
      }
      return send('Token de verificação inválido.', 403);
    }

    if (request.method !== 'POST') {
      return new Response('Método não permitido.', {
        status: 405,
        headers: { Allow: 'GET, POST' }
      });
    }

    try {
      // A assinatura da Meta cobre os bytes exatos recebidos. Não interpretar nem
      // reconstruir o JSON antes de validar, pois escapes de campos de mídia mudam o HMAC.
      const rawBody = Buffer.from(await request.arrayBuffer());
      if (rawBody.length > MAX_BODY_SIZE) return send('Payload muito grande.', 413);

      const signature = request.headers.get('x-hub-signature-256') || '';
      if (!verifySignature(rawBody, signature, process.env.WHATSAPP_APP_SECRET || '')) {
        return send('Assinatura inválida.', 401);
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      waitUntil(processWebhook(payload).catch((error) => console.error('[whatsapp:webhook]', error)));
      return send('EVENT_RECEIVED');
    } catch (error) {
      console.error('[whatsapp:request]', error);
      return send('Requisição inválida.', 400);
    }
  }
};

