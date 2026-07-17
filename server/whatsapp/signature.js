const { createHmac, timingSafeEqual } = require('node:crypto');

const verifySignature = (rawBody, signature, appSecret) => {
  if (!appSecret || !signature?.startsWith('sha256=')) return false;
  const receivedHex = signature.slice(7);
  if (!/^[a-f\d]{64}$/i.test(receivedHex)) return false;
  const received = Buffer.from(receivedHex, 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
};

module.exports = { verifySignature };

