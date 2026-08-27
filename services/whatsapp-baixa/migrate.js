'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { getPool, closePool } = require('./database');

const migrationsDirectory = path.join(__dirname, 'migrations');
const lockName = 'twt-whatsapp-baixa-migrations';

const migrate = async () => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
    await client.query('CREATE SCHEMA IF NOT EXISTS whatsapp_baixa');
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_baixa.schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await fs.readdir(migrationsDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const exists = await client.query(
        'SELECT 1 FROM whatsapp_baixa.schema_migrations WHERE name = $1',
        [file]
      );
      if (exists.rowCount) continue;
      const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO whatsapp_baixa.schema_migrations (name) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log('[whatsapp:migration]', { file, status: 'applied' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => {});
    client.release();
  }
};

if (require.main === module) {
  migrate()
    .then(() => closePool())
    .catch(async (error) => {
      console.error('[whatsapp:migration]', { message: error.message });
      await closePool().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { migrate, migrationsDirectory };
