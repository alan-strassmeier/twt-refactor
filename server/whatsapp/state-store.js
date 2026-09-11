'use strict';

const backend = String(process.env.WHATSAPP_STATE_STORE || 'redis').trim().toLowerCase();

if (backend === 'postgres') {
  module.exports = require('../../services/whatsapp-baixa/postgres-state-store');
} else if (backend === 'redis') {
  module.exports = require('./redis-store');
} else {
  throw new Error(`WHATSAPP_STATE_STORE inválido: ${backend}. Use postgres ou redis.`);
}
