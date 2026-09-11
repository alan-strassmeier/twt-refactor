'use strict';

const backend = String(process.env.WHATSAPP_IMAGE_STORE || 'none').trim().toLowerCase();

if (backend === 'filesystem') {
  module.exports = require('../../services/whatsapp-baixa/proof-image-store');
} else if (backend === 'none') {
  module.exports = {
    saveProofImage: async () => null,
    loadProofImage: async () => null
  };
} else {
  throw new Error(`WHATSAPP_IMAGE_STORE inválido: ${backend}. Use filesystem ou none.`);
}
