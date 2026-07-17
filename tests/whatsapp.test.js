const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');
const { normalizeCteKey, selectCteBarcode } = require('../server/whatsapp/barcode');
const { buildCostsQuery } = require('../server/whatsapp/brudam');
const { formatTimestamp, parseWebhook, parseReceiverReply } = require('../server/whatsapp/processor');
const { verifySignature } = require('../server/whatsapp/signature');

test('valida assinatura oficial do webhook', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'segredo-de-teste';
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifySignature(body, signature, secret), true);
  assert.equal(verifySignature(Buffer.from('alterado'), signature, secret), false);
});

test('valida os bytes originais sem reconstruir JSON de mídia', () => {
  const body = Buffer.from('{"image":{"sha256":"abc\\/def="}}');
  const secret = 'segredo-de-teste';
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const reconstructed = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))));
  assert.equal(verifySignature(body, signature, secret), true);
  assert.equal(verifySignature(reconstructed, signature, secret), false);
});

test('extrai nome, imagem e localização do payload', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '5551999999999', profile: { name: 'Motorista' } }],
    messages: [
      { from: '5551999999999', id: 'loc-1', timestamp: '1', type: 'location', location: { latitude: -29, longitude: -51 } },
      { from: '5551999999999', id: 'img-1', timestamp: '1784233954', type: 'image', image: { id: 'media-1', caption: 'entrega' } },
      { from: '5551999999999', id: 'text-1', timestamp: '1784233955', type: 'text', text: { body: 'João | 123 | Porteiro' } }
    ]
  } }] }] };
  const parsed = parseWebhook(payload);
  assert.equal(parsed.images[0].driverName, 'Motorista');
  assert.equal(parsed.images[0].mediaId, 'media-1');
  assert.deepEqual(parsed.locations[0].location, { latitude: -29, longitude: -51 });
  assert.equal(parsed.texts[0].body, 'João | 123 | Porteiro');
});

test('interpreta dados digitados do recebedor e permite pular', () => {
  assert.deepEqual(parseReceiverReply('João da Silva | 12345678900 | Porteiro'), {
    receiverName: 'João da Silva',
    receiverDocument: '12345678900',
    receiverRelationship: 'Porteiro'
  });
  assert.deepEqual(parseReceiverReply('pular'), {
    receiverName: null,
    receiverDocument: null,
    receiverRelationship: null
  });
  assert.equal(parseReceiverReply('formato inválido'), null);
});

test('converte horário do WhatsApp para São Paulo', () => {
  process.env.APP_TIMEZONE = 'America/Sao_Paulo';
  assert.equal(formatTimestamp(Date.parse('2026-07-14T16:31:11Z') / 1000), '2026-07-14 13:31:11');
});

test('consulta custos pelo parâmetro simples do número do CT-e', () => {
  assert.equal(buildCostsQuery('51057251'), 'numero=51057251&limit=2');
});

test('aceita somente uma chave CT-e numérica de 44 dígitos', () => {
  const key = '43260797434690000129570000000150951192365101';
  assert.equal(normalizeCteKey(key), key);
  assert.equal(normalizeCteKey('51057251'), null);
  assert.equal(normalizeCteKey(`${key}7`), null);
  assert.equal(normalizeCteKey(` ${key} `), key);
});

test('seleciona somente uma chave CT-e válida retornada pelo leitor', () => {
  const key = '43260797434690000129570000000150951192365101';
  assert.deepEqual(selectCteBarcode([
    { isValid: true, text: '51057251', format: 'EAN8' },
    { isValid: true, text: key, format: 'Code128' }
  ]), { text: key, format: 'Code128' });
  assert.equal(selectCteBarcode([
    { isValid: false, text: key, format: 'Code128' }
  ]), null);
});
