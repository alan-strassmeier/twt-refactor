const {
  createHash,
  createHmac,
  timingSafeEqual
} = require('node:crypto');
const billingStore = require('./cobranca-store');

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

const deliveryReference = (event, invoiceId, email) => {
  const normalizedEvent = String(event || '').replace(/[^a-z_]/g, '').slice(0, 12) || 'email';
  const normalizedInvoice = String(invoiceId || '').replace(/\D/g, '').slice(0, 20) || '0';
  const recipientHash = createHash('sha256')
    .update(String(email || '').trim().toLocaleLowerCase('pt-BR'))
    .digest('hex')
    .slice(0, 16);
  return `twt-${normalizedEvent}-${normalizedInvoice}-${recipientHash}`;
};

const readWebhookBody = async (req, maxBytes = MAX_WEBHOOK_BYTES) => {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > maxBytes) throw Object.assign(new Error('Payload muito grande.'), { statusCode: 413 });
    return req.body.toString('utf8');
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > maxBytes) throw Object.assign(new Error('Payload muito grande.'), { statusCode: 413 });
    return req.body;
  }
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body)) > maxBytes) {
      throw Object.assign(new Error('Payload muito grande.'), { statusCode: 413 });
    }
    return req.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw Object.assign(new Error('Payload muito grande.'), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const signedPayloadText = (body) => {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    const preferred = ['eventData', 'event_data', 'data']
      .find((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (preferred) {
      const value = body[preferred];
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    return JSON.stringify(body);
  }

  const text = String(body || '').trim();
  if (!text) throw Object.assign(new Error('Payload do webhook vazio.'), { statusCode: 400 });
  if (text.startsWith('{')) return text;
  const params = new URLSearchParams(text);
  const preferred = ['eventData', 'event_data', 'data'].find((key) => params.has(key));
  const first = preferred ? params.get(preferred) : params.values().next().value;
  if (typeof first !== 'string' || !first) {
    throw Object.assign(new Error('Payload do webhook inválido.'), { statusCode: 400 });
  }
  return first;
};

const signatureParts = (header) => Object.fromEntries(
  String(header || '').split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator > 0
      ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
      : ['', ''];
  }).filter(([key]) => key)
);

const webhookConfig = (env = process.env) => {
  const authenticationKey = String(env.ZOHO_WEBHOOK_AUTH_KEY || '').trim();
  if (authenticationKey.length < 16) {
    throw Object.assign(new Error('Chave de autenticação do webhook do Zoho não configurada.'), {
      statusCode: 503,
      expose: true
    });
  }
  const configuredAge = Number(env.ZOHO_WEBHOOK_MAX_AGE_SECONDS);
  const maxAgeMs = Number.isFinite(configuredAge) && configuredAge >= 60 && configuredAge <= 3600
    ? configuredAge * 1000
    : DEFAULT_MAX_AGE_MS;
  return { authenticationKey, maxAgeMs };
};

const webhookTokenAuthorized = (headers = {}, config = webhookConfig()) => {
  const authorization = String(headers.authorization || '');
  const candidates = [
    authorization.startsWith('Bearer ') ? authorization.slice(7) : '',
    headers['x-twt-webhook-token'],
    headers.zoho_webhook_auth_key,
    headers['zoho-webhook-auth-key']
  ].map((value) => Buffer.from(String(value || ''), 'utf8'));
  const expected = Buffer.from(config.authenticationKey, 'utf8');
  return candidates.some((candidate) => (
    candidate.length === expected.length
    && candidate.length > 0
    && timingSafeEqual(candidate, expected)
  ));
};

const parseWebhookPayload = (body) => {
  let payload;
  try {
    payload = JSON.parse(signedPayloadText(body));
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error('Conteúdo do webhook inválido.'), { statusCode: 400 });
  }
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('Conteúdo do webhook inválido.'), { statusCode: 400 });
  }
  return payload;
};

const validateWebhook = ({ body, signatureHeader, config = webhookConfig(), now = Date.now() }) => {
  const parts = signatureParts(signatureHeader);
  const timestamp = Number(parts.ts);
  if (
    !Number.isFinite(timestamp)
    || parts['s-algorithm'] !== 'HmacSHA256'
    || !parts.s
    || timestamp > now + 60_000
    || now - timestamp > config.maxAgeMs
  ) {
    throw Object.assign(new Error('Assinatura do webhook inválida.'), { statusCode: 401 });
  }

  const payloadText = signedPayloadText(body);
  let received;
  try {
    received = Buffer.from(decodeURIComponent(parts.s), 'base64');
  } catch {
    received = Buffer.alloc(0);
  }
  const expected = createHmac('sha256', config.authenticationKey)
    .update(payloadText, 'utf8')
    .digest();
  if (!received.length || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw Object.assign(new Error('Assinatura do webhook inválida.'), { statusCode: 401 });
  }

  return parseWebhookPayload(payloadText);
};

const firstValue = (value) => Array.isArray(value) ? value[0] : value;

const webhookStatus = (value) => {
  const normalized = String(firstValue(value) || '').toLocaleLowerCase('en-US').replace(/[^a-z]/g, '');
  if (normalized === 'delivered' || normalized === 'emaildelivered') return 'delivered';
  if (normalized === 'softbounce' || normalized === 'softbounced') return 'soft_bounce';
  if (normalized === 'hardbounce' || normalized === 'hardbounced') return 'hard_bounce';
  return '';
};

const eventDate = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const eventDetails = (message) => firstValue(message?.event_data?.details) || {};

const recipientAddress = (emailInfo) => {
  const addresses = emailInfo?.to?.email_address || emailInfo?.to || [];
  const first = firstValue(addresses);
  return String(first?.address || first || '').trim().toLocaleLowerCase('pt-BR');
};

const extractWebhookEvents = (payload) => {
  const messagesValue = payload.event_message ?? payload.eventMessage;
  const messages = Array.isArray(messagesValue)
    ? messagesValue
    : messagesValue && typeof messagesValue === 'object' ? [messagesValue] : [];
  const rootNames = Array.isArray(payload.event_name) ? payload.event_name : [payload.event_name];

  return messages.map((message, index) => {
    const emailInfo = message.email_info || message.emailInfo || {};
    const details = eventDetails(message);
    const status = [
      message.event_name,
      message.eventName,
      message.event_data?.object,
      rootNames[index],
      rootNames[0]
    ].map(webhookStatus).find(Boolean) || '';
    const diagnostic = [
      details.reason,
      details.diagnostic_message || details.diagnosticMessage
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' — ').slice(0, 500);
    return {
      status,
      clientReference: String(emailInfo.client_reference || emailInfo.clientReference || '').trim(),
      emailReference: String(emailInfo.email_reference || emailInfo.emailReference || '').trim(),
      email: recipientAddress(emailInfo),
      providerEventAt: eventDate(
        details.time
        || details.modified_time
        || details.modifiedTime
        || emailInfo.processed_time
        || emailInfo.processedTime
      ),
      diagnostic,
      requestId: String(message.request_id || message.requestId || '').trim(),
      webhookRequestId: String(payload.webhook_request_id || payload.webhookRequestId || '').trim()
    };
  });
};

const statusMessage = (status, diagnostic) => {
  const base = status === 'delivered'
    ? 'O servidor de e-mail do destinatário aceitou a mensagem.'
    : status === 'soft_bounce'
      ? 'O servidor do destinatário recusou temporariamente a entrega.'
      : 'O servidor do destinatário recusou definitivamente a entrega.';
  return diagnostic ? `${base} ${diagnostic}`.slice(0, 700) : base;
};

const webhookEventId = (event) => createHash('sha256').update([
  event.webhookRequestId,
  event.requestId,
  event.clientReference,
  event.status,
  event.providerEventAt
].join('|')).digest('hex');

const processWebhookPayload = async (payload, dependencies = {}) => {
  const store = dependencies.store || billingStore;
  const now = dependencies.now || (() => new Date());
  const events = extractWebhookEvents(payload);
  const summary = { received: events.length, processed: 0, duplicates: 0, ignored: 0 };

  for (const event of events) {
    if (!event.status || !event.clientReference) {
      summary.ignored += 1;
      continue;
    }
    const reference = await store.getDeliveryReference(event.clientReference);
    if (!reference) {
      summary.ignored += 1;
      continue;
    }
    const id = webhookEventId(event);
    if (!await store.claimWebhookEvent(id)) {
      summary.duplicates += 1;
      continue;
    }

    try {
      const current = await store.getDelivery(reference.event, reference.invoiceId, reference.email) || {};
      const currentTimestamp = Date.parse(current.providerEventAt || '');
      const nextTimestamp = Date.parse(event.providerEventAt || '');
      if (Number.isFinite(currentTimestamp) && Number.isFinite(nextTimestamp) && nextTimestamp < currentTimestamp) {
        summary.ignored += 1;
        continue;
      }
      const receivedAt = now().toISOString();
      const record = {
        ...current,
        state: event.status,
        webhookStatus: event.status,
        webhookUpdatedAt: receivedAt,
        ...(event.providerEventAt ? { providerEventAt: event.providerEventAt } : {}),
        ...(event.emailReference ? { emailReference: event.emailReference } : {}),
        ...(event.diagnostic ? { diagnostic: event.diagnostic } : {})
      };
      await store.saveDelivery(reference.event, reference.invoiceId, reference.email, record);
      await store.addLog({
        createdAt: receivedAt,
        event: reference.event,
        status: event.status,
        invoiceId: String(reference.invoiceId),
        clientCnpj: reference.clientCnpj,
        clientName: reference.clientName,
        contactName: reference.contactName,
        email: reference.email || event.email,
        ...(reference.recipientRole ? { recipientRole: reference.recipientRole } : {}),
        clientReference: event.clientReference,
        ...(reference.emailPreview ? { emailPreview: reference.emailPreview } : {}),
        ...(event.emailReference ? { emailReference: event.emailReference } : {}),
        ...(event.providerEventAt ? { providerEventAt: event.providerEventAt } : {}),
        message: statusMessage(event.status, event.diagnostic)
      });
      summary.processed += 1;
    } catch (error) {
      try {
        await store.releaseWebhookEvent(id);
      } catch {
        // Mantém o erro original quando não for possível liberar a reserva no Redis.
      }
      throw error;
    }
  }
  return summary;
};

module.exports = {
  MAX_WEBHOOK_BYTES,
  DEFAULT_MAX_AGE_MS,
  deliveryReference,
  readWebhookBody,
  signedPayloadText,
  signatureParts,
  webhookConfig,
  webhookTokenAuthorized,
  parseWebhookPayload,
  validateWebhook,
  webhookStatus,
  eventDate,
  extractWebhookEvents,
  statusMessage,
  webhookEventId,
  processWebhookPayload
};
