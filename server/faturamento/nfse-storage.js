const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { r2ConfigFromEnv, bodyToString } = require('./r2-doccob');

const cleanPathPart = (value) => String(value || '').replace(/^\/+|\/+$/g, '');

const nfseStorageConfig = (env = process.env) => {
  const hasDedicatedCredentials = [
    env.R2_NFSE_ACCOUNT_ID,
    env.R2_NFSE_ACCESS_KEY_ID,
    env.R2_NFSE_SECRET_ACCESS_KEY
  ].some((value) => String(value || '').trim());
  const storageEnv = hasDedicatedCredentials ? {
    ...env,
    R2_ACCOUNT_ID: env.R2_NFSE_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: env.R2_NFSE_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_NFSE_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: env.R2_NFSE_BUCKET_NAME || env.R2_BUCKET_NAME
  } : env;
  const base = r2ConfigFromEnv(storageEnv);
  if (!base) {
    const detail = hasDedicatedCredentials
      ? 'As credenciais R2_NFSE_* precisam ser cadastradas em conjunto.'
      : 'R2 obrigatório para guardar o XML autorizado da NFS-e.';
    throw Object.assign(new Error(detail), {
      statusCode: 503,
      expose: true
    });
  }
  return {
    ...base,
    nfsePrefix: cleanPathPart(env.R2_NFSE_PREFIX || 'nfse')
  };
};

const createNfseStorage = (config) => {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
  return {
    async putXml(key, xml) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: Buffer.from(xml, 'utf8'),
        ContentType: 'application/xml; charset=utf-8',
        CacheControl: 'private, no-store'
      }));
    },
    async getXml(key) {
      const object = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key
      }));
      return bodyToString(object.Body);
    }
  };
};

const objectKeyFor = ({ invoiceId, accessKey, processedAt, environment, config }) => {
  const year = String(processedAt || '').match(/^(\d{4})/)?.[1] || 'sem-ano';
  const environmentPath = environment === 'production' ? 'production' : 'homologation';
  return [config.nfsePrefix, environmentPath, year, String(invoiceId), `${accessKey}.xml`]
    .map(cleanPathPart)
    .filter(Boolean)
    .join('/');
};

const saveNfseXml = async (document, options = {}) => {
  const config = options.config || nfseStorageConfig();
  const storage = options.storage || createNfseStorage(config);
  const objectKey = objectKeyFor({ ...document, config });
  await storage.putXml(objectKey, document.xml);
  return objectKey;
};

const getNfseXml = async (record, options = {}) => {
  if (!record?.xmlObjectKey) {
    throw Object.assign(new Error('XML da NFS-e não está disponível.'), { statusCode: 404 });
  }
  const config = options.config || nfseStorageConfig();
  const storage = options.storage || createNfseStorage(config);
  return storage.getXml(record.xmlObjectKey);
};

module.exports = {
  nfseStorageConfig,
  createNfseStorage,
  objectKeyFor,
  saveNfseXml,
  getNfseXml
};
