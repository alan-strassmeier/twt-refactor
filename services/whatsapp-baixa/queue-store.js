'use strict';

const { getPool } = require('./database');
const { cleanupExpiredImages } = require('./proof-image-store');

const enqueueWebhook = async (eventKey, payload) => {
  const result = await getPool().query(`
    INSERT INTO whatsapp_baixa.webhook_inbox (event_key, payload)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id
  `, [eventKey, JSON.stringify(payload)]);
  return { inserted: result.rowCount === 1, id: result.rows[0]?.id || null };
};

const claimNext = async (leaseSeconds) => {
  const result = await getPool().query(`
    WITH candidate AS (
      SELECT id
      FROM whatsapp_baixa.webhook_inbox
      WHERE (
        status = 'pending' AND available_at <= now()
      ) OR (
        status = 'processing'
        AND locked_at <= now() - ($1 * interval '1 second')
      )
      ORDER BY available_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE whatsapp_baixa.webhook_inbox AS inbox
    SET status = 'processing',
        attempts = attempts + 1,
        locked_at = now(),
        updated_at = now(),
        last_error = NULL
    FROM candidate
    WHERE inbox.id = candidate.id
    RETURNING inbox.id, inbox.event_key, inbox.payload, inbox.attempts
  `, [leaseSeconds]);
  return result.rows[0] || null;
};

const markDone = (id) => getPool().query(`
  UPDATE whatsapp_baixa.webhook_inbox
  SET status = 'done', processed_at = now(), locked_at = NULL,
      last_error = NULL, updated_at = now()
  WHERE id = $1
`, [id]);

const markFailed = (id, error, { dead, delaySeconds }) => getPool().query(`
  UPDATE whatsapp_baixa.webhook_inbox
  SET status = $2,
      available_at = CASE WHEN $2 = 'pending'
        THEN now() + ($3 * interval '1 second')
        ELSE available_at
      END,
      locked_at = NULL,
      last_error = left($4, 4000),
      updated_at = now()
  WHERE id = $1
`, [id, dead ? 'dead' : 'pending', delaySeconds, String(error?.message || error)]);

const isReady = async () => {
  try {
    const result = await getPool().query(
      `SELECT
         to_regclass('whatsapp_baixa.webhook_inbox') AS inbox,
         to_regclass('whatsapp_baixa.state_kv') AS state,
         to_regclass('whatsapp_baixa.proof_images') AS images`
    );
    return Boolean(result.rows[0]?.inbox && result.rows[0]?.state && result.rows[0]?.images);
  } catch {
    return false;
  }
};

const cleanupExpired = async () => {
  const state = await getPool().query(`
    DELETE FROM whatsapp_baixa.state_kv
    WHERE expires_at <= now()
  `);
  const inbox = await getPool().query(`
    DELETE FROM whatsapp_baixa.webhook_inbox
    WHERE (status = 'done' AND processed_at < now() - interval '90 days')
       OR (status = 'dead' AND updated_at < now() - interval '180 days')
  `);
  const images = await cleanupExpiredImages();
  return { state: state.rowCount, inbox: inbox.rowCount, images };
};

module.exports = {
  enqueueWebhook,
  claimNext,
  markDone,
  markFailed,
  isReady,
  cleanupExpired
};
