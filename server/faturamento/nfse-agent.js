const { randomBytes, timingSafeEqual } = require('node:crypto');
const { nfseConfig, configurationError } = require('./nfse-config');
const { decodeAuthorizedXml } = require('./nfse-client');
const { finalizeAuthorizedDocument, publicResult } = require('./nfse');
const store = require('./nfse-store');

const AGENT_XML_MAX_BYTES = 512 * 1024;

const boundedInteger = (value, fallback, minimum, maximum) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum
    ? Math.min(number, maximum)
    : fallback;
};

const agentConfigFromEnv = (env = process.env) => {
  const token = String(env.NFSE_AGENT_TOKEN || '').trim();
  if (Buffer.byteLength(token, 'utf8') < 32) {
    throw configurationError('NFSE_AGENT_TOKEN deve ter pelo menos 32 caracteres aleatórios.');
  }
  return {
    token,
    leaseMs: boundedInteger(env.NFSE_AGENT_LEASE_MS, 300000, 60000, 900000)
  };
};

const bearerTokenFromRequest = (req) => {
  const authorization = String(req.headers?.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

const constantTimeEqual = (actual, expected) => {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

const authenticateNfseAgent = (req, env = process.env) => {
  const config = agentConfigFromEnv(env);
  if (!constantTimeEqual(bearerTokenFromRequest(req), config.token)) {
    throw Object.assign(new Error('Credencial do agente inválida.'), { statusCode: 401 });
  }
  return config;
};

const cleanAgentId = (value) => {
  const agentId = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(agentId)) {
    throw Object.assign(new Error('Identificador do agente inválido.'), { statusCode: 422 });
  }
  return agentId;
};

const unsignedXmlFromRecord = (record) => {
  const encoded = String(record?.unsignedDpsBase64 || '').replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Object.assign(new Error('O trabalho não contém uma DPS válida.'), { statusCode: 500 });
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > AGENT_XML_MAX_BYTES) {
    throw Object.assign(new Error('A DPS do trabalho excede o limite permitido.'), { statusCode: 500 });
  }
  const xml = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!/^<\?xml[^>]*>\s*<(?:\w+:)?DPS\b|^<(?:\w+:)?DPS\b/i.test(xml) ||
      /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw Object.assign(new Error('A DPS do trabalho possui conteúdo inesperado.'), { statusCode: 500 });
  }
  return xml;
};

const publicAgentJob = (record, fiscalConfig) => {
  // Uma concessão repetida pode significar que o agente anterior transmitiu a DPS,
  // mas caiu antes de devolver o resultado. Nesse caso somente consultamos o Id.
  const action = record.jobAction === 'recover' || Number(record.attempts) > 1
    ? 'recover'
    : 'issue';
  return {
    jobId: String(record.invoiceId),
    invoiceId: String(record.invoiceId),
    action,
    environment: record.environment,
    apiBaseUrl: fiscalConfig.baseUrl,
    requestTimeoutMs: fiscalConfig.requestTimeoutMs,
    dpsId: record.dpsId,
    dpsNumber: String(record.dpsNumber || ''),
    dpsSeries: String(record.dpsSeries || ''),
    unsignedDpsXml: action === 'recover' ? '' : unsignedXmlFromRecord(record),
    leaseToken: record.leaseToken,
    leaseExpiresAt: record.leaseExpiresAt
  };
};

const claimAgentJob = async ({ agentId }, dependencies = {}) => {
  const fiscalConfig = dependencies.config || nfseConfig(process.env, { requireCertificate: false });
  if (fiscalConfig.certificateMode !== 'agent') {
    throw configurationError('A emissão de NFS-e não está configurada para o agente A3.');
  }
  const agentConfig = dependencies.agentConfig || agentConfigFromEnv();
  const now = Number(dependencies.now || Date.now());
  const leaseToken = randomBytes(32).toString('hex');
  const claim = dependencies.claimNextNfseJob || store.claimNextNfseJob;
  const record = await claim({
    environment: fiscalConfig.environment,
    agentId: cleanAgentId(agentId),
    leaseToken,
    now,
    leaseMs: agentConfig.leaseMs
  });
  return record ? publicAgentJob(record, fiscalConfig) : null;
};

const sanitizeMessages = (messages) => (Array.isArray(messages) ? messages : [messages])
  .filter((message) => typeof message === 'string' && message.trim())
  .slice(0, 20)
  .map((message) => message.replace(/[\r\n]+/g, ' ').trim().slice(0, 500));

const withoutAgentSecrets = (record) => {
  const clean = { ...record };
  delete clean.leaseToken;
  delete clean.leaseExpiresAtEpoch;
  delete clean.leaseExpiresAt;
  delete clean.unsignedDpsBase64;
  return clean;
};

const completeAgentJob = async (payload, dependencies = {}) => {
  const invoiceId = String(payload.invoiceId || '');
  const leaseToken = String(payload.leaseToken || '');
  const agentId = cleanAgentId(payload.agentId);
  if (!/^\d{1,20}$/.test(invoiceId) || !/^[a-f0-9]{64}$/i.test(leaseToken)) {
    throw Object.assign(new Error('Identificação do trabalho inválida.'), { statusCode: 422 });
  }
  const assertLease = dependencies.assertNfseJobLease || store.assertNfseJobLease;
  const getRecord = dependencies.getNfseRecord || store.getNfseRecord;
  const removeQueue = dependencies.removeNfseJobFromQueue || store.removeNfseJobFromQueue;
  const saveRecord = dependencies.saveNfseRecord || store.saveNfseRecord;
  const current = await getRecord(invoiceId);
  if (current && ['issued', 'failed'].includes(current.state)) {
    return publicResult(current, false);
  }
  const record = await assertLease({ invoiceId, leaseToken, agentId });
  const outcome = String(payload.outcome || '').toLowerCase();

  if (outcome === 'issued') {
    const xml = decodeAuthorizedXml({ nfseXmlGZipB64: payload.authorizedXmlGZipB64 });
    const response = {
      chaveAcesso: String(payload.accessKey || ''),
      alertas: sanitizeMessages(payload.alerts)
    };
    const issued = await (dependencies.finalizeAuthorizedDocument || finalizeAuthorizedDocument)({
      record: withoutAgentSecrets(record),
      response,
      xml
    }, dependencies);
    await removeQueue(record);
    return publicResult(issued, true);
  }

  if (!['rejected', 'ambiguous', 'not_found'].includes(outcome)) {
    throw Object.assign(new Error('Resultado do agente inválido.'), { statusCode: 422 });
  }
  const messages = sanitizeMessages(payload.messages);
  const ambiguous = outcome === 'ambiguous';
  const failedRecord = {
    ...withoutAgentSecrets(record),
    state: ambiguous ? 'review' : 'failed',
    reviewReason: ambiguous ? 'agent_ambiguous' : undefined,
    failureReason: outcome,
    upstreamStatus: Number(payload.upstreamStatus) || 0,
    upstreamMessages: messages,
    lastError: messages[0] || (ambiguous
      ? 'Não foi possível confirmar se a DPS foi autorizada.'
      : 'A DPS não foi autorizada.'),
    finishedAt: new Date().toISOString()
  };
  await saveRecord(invoiceId, failedRecord);
  await removeQueue(record);
  return publicResult(failedRecord, false);
};

module.exports = {
  AGENT_XML_MAX_BYTES,
  agentConfigFromEnv,
  bearerTokenFromRequest,
  constantTimeEqual,
  authenticateNfseAgent,
  cleanAgentId,
  unsignedXmlFromRecord,
  publicAgentJob,
  claimAgentJob,
  sanitizeMessages,
  withoutAgentSecrets,
  completeAgentJob
};
