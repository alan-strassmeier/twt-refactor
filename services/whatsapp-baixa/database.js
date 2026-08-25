'use strict';

const { Pool } = require('pg');

let pool;

const getPool = () => {
  if (pool) return pool;
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  pool = new Pool({
    ...(connectionString ? { connectionString } : {}),
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'twt-whatsapp-baixa'
  });
  pool.on('error', (error) => {
    console.error('[whatsapp:postgres-pool]', { message: error.message });
  });
  return pool;
};

const closePool = async () => {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
};

module.exports = { getPool, closePool };
