'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getPool } = require('./database');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const extensionFor = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  return 'jpg';
};

const imageFileName = (messageId, mimeType) =>
  `${createHash('sha256').update(String(messageId)).digest('hex')}.${extensionFor(mimeType)}`;

const safeFilePath = (storagePath, fileName) => {
  if (!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(String(fileName))) {
    throw new Error('Nome de arquivo de comprovante inválido.');
  }
  return path.join(storagePath, fileName);
};

const atomicWrite = async (storagePath, fileName, bytes, minFreeBytes) => {
  await fs.mkdir(storagePath, { recursive: true, mode: 0o700 });
  const filesystem = await fs.statfs(storagePath);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (availableBytes - bytes.length < minFreeBytes) {
    throw new Error('Espaço livre insuficiente para armazenar o comprovante.');
  }
  const destination = safeFilePath(storagePath, fileName);
  const temporary = path.join(
    storagePath,
    `.${fileName}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
};

const createImageStore = ({ pool, storagePath, retentionDays = 30, minFreeBytes = 0 }) => {
  if (!storagePath) throw new Error('WHATSAPP_IMAGE_STORAGE_PATH não configurado.');
  if (retentionDays !== 30) throw new Error('A retenção de comprovantes deve ser de 30 dias.');

  const saveProofImage = async ({ messageId, bytes, mimeType }) => {
    if (!messageId || !Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new Error('Comprovante inválido para armazenamento.');
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error('O comprovante ultrapassa o limite de 20 MB.');
    }
    const fileName = imageFileName(messageId, mimeType);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await atomicWrite(storagePath, fileName, bytes, minFreeBytes);
    await pool.query(`
      INSERT INTO whatsapp_baixa.proof_images (
        message_id, file_name, mime_type, size_bytes, sha256, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 day'))
      ON CONFLICT (message_id) DO UPDATE
      SET file_name = EXCLUDED.file_name,
          mime_type = EXCLUDED.mime_type,
          size_bytes = EXCLUDED.size_bytes,
          sha256 = EXCLUDED.sha256
    `, [messageId, fileName, mimeType, bytes.length, checksum, retentionDays]);
    return { fileName, mimeType, size: bytes.length, checksum };
  };

  const loadProofImage = async (messageId) => {
    const result = await pool.query(`
      SELECT file_name, mime_type, sha256
      FROM whatsapp_baixa.proof_images
      WHERE message_id = $1 AND expires_at > now()
    `, [messageId]);
    const stored = result.rows[0];
    if (!stored) return null;
    let bytes;
    try {
      bytes = await fs.readFile(safeFilePath(storagePath, stored.file_name));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== stored.sha256) {
      throw new Error('Integridade do comprovante armazenado inválida.');
    }
    return { bytes, mimeType: stored.mime_type };
  };

  const cleanupExpiredImages = async () => {
    const result = await pool.query(`
      SELECT message_id, file_name
      FROM whatsapp_baixa.proof_images
      WHERE expires_at <= now()
      ORDER BY expires_at
      LIMIT 500
    `);
    const removedIds = [];
    for (const image of result.rows) {
      await fs.unlink(safeFilePath(storagePath, image.file_name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      removedIds.push(image.message_id);
    }
    if (removedIds.length) {
      await pool.query(
        'DELETE FROM whatsapp_baixa.proof_images WHERE message_id = ANY($1::text[])',
        [removedIds]
      );
    }

    let orphaned = 0;
    let temporaries = 0;
    const entries = await fs.readdir(storagePath, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(storagePath, entry.name);
      const stats = await fs.stat(filePath);
      if (/^\..+\.tmp$/.test(entry.name) && stats.mtimeMs <= now - 24 * 60 * 60 * 1000) {
        await fs.unlink(filePath);
        temporaries += 1;
        continue;
      }
      if (!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(entry.name) ||
          stats.mtimeMs > now - retentionDays * 24 * 60 * 60 * 1000) continue;
      const referenced = await pool.query(
        'SELECT 1 FROM whatsapp_baixa.proof_images WHERE file_name = $1',
        [entry.name]
      );
      if (!referenced.rowCount) {
        await fs.unlink(filePath);
        orphaned += 1;
      }
    }
    return { expired: removedIds.length, orphaned, temporaries };
  };

  return { saveProofImage, loadProofImage, cleanupExpiredImages };
};

let defaultStore;
const getDefaultStore = () => {
  if (!defaultStore) {
    defaultStore = createImageStore({
      pool: getPool(),
      storagePath: String(process.env.WHATSAPP_IMAGE_STORAGE_PATH || '').trim(),
      retentionDays: Number(process.env.WHATSAPP_IMAGE_RETENTION_DAYS || 30),
      minFreeBytes: Number(process.env.WHATSAPP_IMAGE_MIN_FREE_BYTES || 1073741824)
    });
  }
  return defaultStore;
};

module.exports = {
  MAX_IMAGE_BYTES,
  extensionFor,
  imageFileName,
  safeFilePath,
  createImageStore,
  saveProofImage: (...args) => getDefaultStore().saveProofImage(...args),
  loadProofImage: (...args) => getDefaultStore().loadProofImage(...args),
  cleanupExpiredImages: (...args) => getDefaultStore().cleanupExpiredImages(...args)
};
