const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { parseDoccob } = require('./doccob');

const DOCCOB_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SCAN_LIMIT = 250;
const DOWNLOAD_CONCURRENCY = 6;
const doccobCache = new Map();

const positiveInteger = (value, fallback, maximum) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0
    ? Math.min(number, maximum)
    : fallback;
};

const cleanPathPart = (value) => String(value || '').replace(/^\/+|\/+$/g, '');

const r2ConfigFromEnv = (env = process.env) => {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = String(env.R2_BUCKET_NAME || 'twt-brudam-documentos').trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    basePrefix: cleanPathPart(env.R2_DOCCOB_PREFIX || 'brudam/clientes'),
    scanLimit: positiveInteger(env.R2_DOCCOB_SCAN_LIMIT, DEFAULT_SCAN_LIMIT, 2000)
  };
};

const bodyToString = async (body) => {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body.transformToString === 'function') return body.transformToString('utf-8');
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('Formato de arquivo inesperado no R2.');
};

const createR2Storage = (config) => {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
  return {
    async listObjects(prefix) {
      const objects = [];
      let continuationToken;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        }));
        objects.push(...(page.Contents || []));
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },
    async getObject(key) {
      const object = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key
      }));
      return bodyToString(object.Body);
    }
  };
};

const cacheKeyFor = (clientCnpj, invoiceId) => `${clientCnpj}:${invoiceId}`;

const cachedDoccob = (key) => {
  const cached = doccobCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    doccobCache.delete(key);
    return null;
  }
  return cached.value;
};

const sortNewestFirst = (objects) => [...objects].sort((left, right) =>
  new Date(right.LastModified || 0).getTime() - new Date(left.LastModified || 0).getTime());

const findDoccobForInvoice = async ({
  invoiceId,
  clientCnpj,
  config = r2ConfigFromEnv(),
  storage = null
}) => {
  if (!config && !storage) return null;
  const normalizedCnpj = String(clientCnpj || '').replace(/\D/g, '');
  const normalizedInvoice = String(invoiceId || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (normalizedCnpj.length !== 14 || !normalizedInvoice) return null;

  const key = cacheKeyFor(normalizedCnpj, normalizedInvoice);
  const cached = cachedDoccob(key);
  if (cached) return cached;

  const activeConfig = config || {
    basePrefix: 'brudam/clientes',
    scanLimit: DEFAULT_SCAN_LIMIT
  };
  const activeStorage = storage || createR2Storage(activeConfig);
  const prefix = [activeConfig.basePrefix, normalizedCnpj, 'doccob']
    .map(cleanPathPart)
    .filter(Boolean)
    .join('/') + '/';
  const objects = sortNewestFirst(await activeStorage.listObjects(prefix))
    .filter((object) => typeof object.Key === 'string' && /\.txt$/i.test(object.Key))
    .slice(0, activeConfig.scanLimit || DEFAULT_SCAN_LIMIT);

  for (let offset = 0; offset < objects.length; offset += DOWNLOAD_CONCURRENCY) {
    const batch = objects.slice(offset, offset + DOWNLOAD_CONCURRENCY);
    const parsed = await Promise.all(batch.map(async (object) => {
      try {
        const content = await activeStorage.getObject(object.Key);
        const doccob = parseDoccob(content, normalizedInvoice);
        return doccob.invoice?.id === normalizedInvoice
          ? { ...doccob, objectKey: object.Key, lastModified: object.LastModified || null }
          : null;
      } catch (error) {
        console.warn('[faturamento:doccob-object]', {
          objectKey: object.Key,
          error: error.message
        });
        return null;
      }
    }));
    const match = parsed.find(Boolean);
    if (match) {
      doccobCache.set(key, {
        value: match,
        expiresAt: Date.now() + DOCCOB_CACHE_TTL_MS
      });
      return match;
    }
  }
  return null;
};

module.exports = {
  DEFAULT_SCAN_LIMIT,
  r2ConfigFromEnv,
  bodyToString,
  createR2Storage,
  findDoccobForInvoice
};
