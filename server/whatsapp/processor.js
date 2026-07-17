const { readBarcode } = require('./barcode');
const { readReceiver } = require('./openai-reader');
const { resolveMinutaAndClient, createDeliveryOccurrence } = require('./brudam');
const { downloadMedia, sendText } = require('./meta');
const store = require('./redis-store');

const formatTimestamp = (epochSeconds) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
};

const parseWebhook = (payload) => {
  const images = [];
  const locations = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        const senderPhone = String(message.from || '');
        if (!senderPhone) continue;
        const contact = contacts.find((item) => item.wa_id === senderPhone) || contacts[0];
        const driverName = String(contact?.profile?.name || senderPhone).trim();
        if (message.type === 'location') {
          const latitude = Number(message.location?.latitude);
          const longitude = Number(message.location?.longitude);
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            locations.push({ senderPhone, location: { latitude, longitude } });
          }
        }
        if (message.type === 'image' && message.image?.id && message.id && message.timestamp) {
          images.push({
            messageId: String(message.id),
            mediaId: String(message.image.id),
            caption: String(message.image.caption || ''),
            senderPhone,
            driverName,
            timestamp: Number(message.timestamp)
          });
        }
      }
    }
  }
  return { images, locations };
};

const safeReply = async (to, text) => {
  try {
    await sendText(to, text);
  } catch (error) {
    console.error('[whatsapp:reply]', error);
  }
};

const processImage = async (image) => {
  if (!await store.claimMessage(image.messageId)) return;
  let occurrenceCreated = false;
  try {
    const media = await downloadMedia(image.mediaId);
    const [barcode, proof] = await Promise.all([
      readBarcode(media.bytes),
      readReceiver(media.bytes, media.mimeType, image.caption)
    ]);
    if (!barcode) {
      await store.markMessageDone(image.messageId);
      await safeReply(image.senderPhone,
        'Não consegui ler o código de barras. Refaça a foto com o código inteiro, nítido e sem reflexo.');
      return;
    }

    const cteIdentifier = barcode.text.replace(/\D/g, '');
    const resolved = await resolveMinutaAndClient(cteIdentifier);
    if (!resolved) {
      await store.markMessageDone(image.messageId);
      await safeReply(image.senderPhone,
        `Li o CT-e ${barcode.text}, mas a Brudam não retornou uma única minuta e cliente correspondentes. A baixa não foi realizada.`);
      return;
    }

    const location = await store.takeLocation(image.senderPhone);
    await createDeliveryOccurrence({
      minuta: resolved.minuta,
      clientCnpj: resolved.clientCnpj,
      timestamp: formatTimestamp(image.timestamp),
      driverName: image.driverName,
      senderPhone: image.senderPhone,
      messageId: image.messageId,
      image: media.bytes,
      mimeType: media.mimeType,
      proof,
      barcode,
      location
    });
    occurrenceCreated = true;
    await store.markMessageDone(image.messageId);
    await safeReply(image.senderPhone, `Entrega registrada com sucesso. Minuta ${resolved.minuta}.`);
  } catch (error) {
    console.error('[whatsapp:proof]', { messageId: image.messageId, error });
    if (!occurrenceCreated) await store.releaseMessage(image.messageId).catch(() => {});
    await safeReply(image.senderPhone,
      'Não foi possível registrar este comprovante. A baixa não foi confirmada; confira a foto e tente novamente.');
  }
};

const processWebhook = async (payload) => {
  const { images, locations } = parseWebhook(payload);
  await Promise.all(locations.map((item) => store.saveLocation(item.senderPhone, item.location)));
  await Promise.all(images.map(processImage));
};

module.exports = { formatTimestamp, parseWebhook, processWebhook };
