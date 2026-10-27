const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { redisCommand } = require('./boleto-store');

const CACHE_PREFIX = 'faturamento:cobranca:conjunta:anexos:v1:';
const CACHE_TTL_SECONDS = 30 * 60;
const CHUNK_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const MAX_ENCODED_BYTES = 28 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_ENCODED_BYTES / CHUNK_BYTES);
const cacheError = (message) => Object.assign(new Error(message), {
  statusCode: 409, retryable: true, retryStage: 'prepare'
});
const digest = (value) => createHash('sha256').update(value).digest('base64url');
const secretFor = (options) => String(options.secret || process.env.FATURAMENTO_SESSION_SECRET || '');
const nowFor = (options) => (options.now ? options.now() : new Date()).getTime();
const keyFor = (key, index) => `${CACHE_PREFIX}${key}:${index}`;

const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');
const requireSecret = (options) => {
  const secret = secretFor(options);
  if (secret.length < 32) throw Object.assign(new Error('Assinatura da prévia de cobrança não configurada.'), {
    statusCode: 503, expose: true
  });
  return secret;
};

const savePreparedPackage = async ({ cnpj, invoiceId, proof, attachments }, options = {}) => {
  const secret = requireSecret(options);
  if (!Array.isArray(attachments) || !attachments.length || attachments.length > 4
    || attachments.some((item) => !Buffer.isBuffer(item.content) || !item.content.length
      || !/^[-a-z0-9]+\.pdf$/.test(String(item.filename))
      || item.contentType !== 'application/pdf')) {
    throw cacheError('Os anexos desta fatura são inválidos. Tente prepará-la novamente.');
  }
  const totalBytes = attachments.reduce((sum, item) => sum + item.content.length, 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error('Os anexos desta fatura ultrapassam 18 MB.'), { statusCode: 413 });
  }
  const encoded = gzipSync(Buffer.from(JSON.stringify({
    invoiceId, cnpj, proofHash: digest(proof),
    attachments: attachments.map(({ filename, contentType, content }) => ({
      filename, contentType, content: content.toString('base64')
    }))
  })));
  if (encoded.length > MAX_ENCODED_BYTES) {
    throw Object.assign(new Error('Os anexos desta fatura são grandes demais para a preparação.'), {
      statusCode: 413
    });
  }
  const key = randomUUID();
  const parts = Math.ceil(encoded.length / CHUNK_BYTES);
  const command = options.command || redisCommand;
  const savedKeys = [];
  try {
    for (let index = 0; index < parts; index += 1) {
      const cacheKey = keyFor(key, index);
      const result = await command('SET', cacheKey,
        encoded.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64url'),
        'EX', String(CACHE_TTL_SECONDS));
      if (result !== 'OK') throw cacheError('Não foi possível guardar os anexos desta fatura.');
      savedKeys.push(cacheKey);
    }
  } catch (error) {
    if (savedKeys.length) await command('DEL', ...savedKeys).catch(() => {});
    throw error;
  }
  const tokenPayload = Buffer.from(JSON.stringify({
    v: 1, key, parts, invoiceId, cnpj, proofHash: digest(proof),
    checksum: digest(encoded), totalBytes,
    expiresAt: nowFor(options) + CACHE_TTL_SECONDS * 1000
  })).toString('base64url');
  return {
    token: `${tokenPayload}.${sign(tokenPayload, secret)}`,
    filenames: attachments.map((item) => item.filename), totalBytes
  };
};

const loadPreparedPackage = async ({ token, cnpj, invoiceId, proof }, options = {}) => {
  const secret = requireSecret(options);
  const [payload, signature, extra] = String(token || '').split('.');
  const expected = payload ? sign(payload, secret) : '';
  if (!payload || !signature || extra || payload.length > 2048
    || signature.length !== expected.length
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw cacheError(`Os anexos preparados da fatura ${invoiceId} são inválidos. Tente novamente esta fatura.`);
  }
  let meta;
  try { meta = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { /* inválido */ }
  if (meta?.v !== 1 || meta.invoiceId !== invoiceId || meta.cnpj !== cnpj
    || meta.proofHash !== digest(proof)
    || !/^[0-9a-f-]{36}$/.test(meta.key)
    || !Number.isSafeInteger(meta.parts) || meta.parts < 1 || meta.parts > MAX_CHUNKS
    || !Number.isFinite(meta.expiresAt) || meta.expiresAt <= nowFor(options)
    || !Number.isSafeInteger(meta.totalBytes) || meta.totalBytes < 1
    || meta.totalBytes > MAX_ATTACHMENT_BYTES) {
    throw cacheError(`Os anexos preparados da fatura ${invoiceId} expiraram ou não correspondem à prévia.`);
  }
  const command = options.command || redisCommand;
  const chunks = [];
  for (let index = 0; index < meta.parts; index += 6) {
    const keys = Array.from({ length: Math.min(6, meta.parts - index) }, (_, offset) =>
      keyFor(meta.key, index + offset));
    const values = await command('MGET', ...keys);
    if (!Array.isArray(values) || values.length !== keys.length || values.some((value) => !value)) {
      throw cacheError(`Os anexos preparados da fatura ${invoiceId} expiraram. Tente novamente esta fatura.`);
    }
    chunks.push(...values.map((value) => Buffer.from(value, 'base64url')));
  }
  const encoded = Buffer.concat(chunks);
  if (encoded.length > MAX_ENCODED_BYTES || digest(encoded) !== meta.checksum) {
    throw cacheError(`Os anexos preparados da fatura ${invoiceId} falharam na conferência de integridade.`);
  }
  let packageData;
  try {
    packageData = JSON.parse(gunzipSync(encoded, { maxOutputLength: MAX_ENCODED_BYTES }).toString('utf8'));
  } catch {
    throw cacheError(`Os anexos preparados da fatura ${invoiceId} não puderam ser lidos.`);
  }
  if (packageData?.invoiceId !== invoiceId || packageData?.cnpj !== cnpj
    || packageData?.proofHash !== meta.proofHash
    || !Array.isArray(packageData.attachments) || !packageData.attachments.length
    || packageData.attachments.length > 4) {
    throw cacheError(`Os anexos preparados da fatura ${invoiceId} não correspondem à prévia.`);
  }
  const attachments = packageData.attachments.map((item) => ({
    filename: item.filename, contentType: item.contentType,
    content: Buffer.from(String(item.content || ''), 'base64')
  }));
  if (attachments.some((item) => !/^[-a-z0-9]+\.pdf$/.test(String(item.filename))
      || item.contentType !== 'application/pdf' || !item.content.length)
    || attachments.reduce((sum, item) => sum + item.content.length, 0) !== meta.totalBytes) {
    throw cacheError(`Os anexos preparados da fatura ${invoiceId} são inválidos.`);
  }
  return attachments;
};

module.exports = { savePreparedPackage, loadPreparedPackage };
