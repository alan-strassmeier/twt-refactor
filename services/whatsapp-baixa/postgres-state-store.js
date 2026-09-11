'use strict';

const { getPool } = require('./database');

const DELIVERY_ATTEMPT_TTL_SECONDS = 15 * 60;
const MESSAGE_PROCESSING_TTL_SECONDS = 15 * 60;
const MESSAGE_DONE_TTL_SECONDS = 90 * 24 * 60 * 60;
const DELIVERED_MINUTA_TTL_SECONDS = 365 * 24 * 60 * 60;

const pendingKey = (phone) => `whatsapp:pending:${phone}`;
const stateKey = (phone) => `whatsapp:state:${phone}`;
const deliveryTimestampKey = (phone) => `whatsapp:delivery-timestamp:${phone}`;
const locationKey = (phone) => `whatsapp:location:${phone}`;
const messageKey = (messageId) => `whatsapp:message:${messageId}`;
const deliveredMinutaKey = (minuta) => `whatsapp:delivered:minuta:${minuta}`;

const putWithClient = (client, key, value, ttlSeconds) => client.query(`
  INSERT INTO whatsapp_baixa.state_kv (key, value, expires_at)
  VALUES ($1, $2::jsonb, now() + ($3 * interval '1 second'))
  ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
`, [key, JSON.stringify(value), ttlSeconds]);

const put = (key, value, ttlSeconds) =>
  putWithClient(getPool(), key, value, ttlSeconds);

const get = async (key) => {
  const result = await getPool().query(`
    SELECT value
    FROM whatsapp_baixa.state_kv
    WHERE key = $1 AND expires_at > now()
  `, [key]);
  return result.rows[0]?.value ?? null;
};

const remove = (...keys) => {
  if (!keys.length) return Promise.resolve();
  return getPool().query(
    'DELETE FROM whatsapp_baixa.state_kv WHERE key = ANY($1::text[])',
    [keys]
  );
};

const take = async (key) => {
  const result = await getPool().query(`
    DELETE FROM whatsapp_baixa.state_kv
    WHERE key = $1 AND expires_at > now()
    RETURNING value
  `, [key]);
  return result.rows[0]?.value ?? null;
};

const claimMessage = async (messageId) => {
  const result = await getPool().query(`
    INSERT INTO whatsapp_baixa.state_kv (key, value, expires_at)
    VALUES ($1, '"processing"'::jsonb, now() + ($2 * interval '1 second'))
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    WHERE whatsapp_baixa.state_kv.expires_at <= now()
    RETURNING key
  `, [messageKey(messageId), MESSAGE_PROCESSING_TTL_SECONDS]);
  return result.rowCount === 1;
};

const markMessageDone = (messageId) =>
  put(messageKey(messageId), 'done', MESSAGE_DONE_TTL_SECONDS);

const releaseMessage = (messageId) => remove(messageKey(messageId));

const saveLocation = (phone, location) =>
  put(locationKey(phone), location, DELIVERY_ATTEMPT_TTL_SECONDS);

const takeLocation = (phone) => take(locationKey(phone));

const saveConversationState = (phone, state) =>
  put(stateKey(phone), state, DELIVERY_ATTEMPT_TTL_SECONDS);

const getConversationState = (phone) => get(stateKey(phone));
const clearConversationState = (phone) => remove(stateKey(phone));

const saveDeliveryTimestamp = (phone, timestamp) =>
  put(deliveryTimestampKey(phone), timestamp, DELIVERY_ATTEMPT_TTL_SECONDS);

const getDeliveryTimestamp = (phone) => get(deliveryTimestampKey(phone));
const clearDeliveryTimestamp = (phone) => remove(deliveryTimestampKey(phone));

const savePendingDelivery = (phone, delivery) =>
  put(pendingKey(phone), delivery, DELIVERY_ATTEMPT_TTL_SECONDS);

const getPendingDelivery = (phone) => get(pendingKey(phone));

const clearPendingDelivery = (phone) =>
  remove(pendingKey(phone), stateKey(phone));

const clearDeliveryAttempt = (phone) => remove(
  pendingKey(phone),
  stateKey(phone),
  deliveryTimestampKey(phone),
  locationKey(phone)
);

const hasDeliveredMinuta = async (minuta) =>
  Boolean(await get(deliveredMinutaKey(minuta)));

const markDeliveredMinuta = (minuta) =>
  put(deliveredMinutaKey(minuta), 'done', DELIVERED_MINUTA_TTL_SECONDS);

const completePendingDelivery = async (phone, imageMessageId, textMessageId) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM whatsapp_baixa.state_kv WHERE key = ANY($1::text[])',
      [[pendingKey(phone), stateKey(phone), deliveryTimestampKey(phone)]]
    );
    await putWithClient(client, messageKey(imageMessageId), 'done', MESSAGE_DONE_TTL_SECONDS);
    await putWithClient(client, messageKey(textMessageId), 'done', MESSAGE_DONE_TTL_SECONDS);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  DELIVERY_ATTEMPT_TTL_SECONDS,
  claimMessage,
  markMessageDone,
  releaseMessage,
  saveLocation,
  takeLocation,
  savePendingDelivery,
  getPendingDelivery,
  saveConversationState,
  getConversationState,
  clearConversationState,
  saveDeliveryTimestamp,
  getDeliveryTimestamp,
  clearDeliveryTimestamp,
  clearPendingDelivery,
  clearDeliveryAttempt,
  hasDeliveredMinuta,
  markDeliveredMinuta,
  completePendingDelivery
};
