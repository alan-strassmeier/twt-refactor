const { readBarcode } = require('./barcode');
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
  const texts = [];
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
        if (message.type === 'text' && message.text?.body && message.id) {
          texts.push({
            messageId: String(message.id),
            senderPhone,
            body: String(message.text.body).trim()
          });
        }
      }
    }
  }
  return { images, locations, texts };
};

const emptyProof = () => ({
  receiverName: null,
  receiverDocument: null,
  receiverRelationship: null
});

const parseReceiverReply = (body) => {
  const value = String(body || '').trim();
  if (/^pular$/i.test(value)) return emptyProof();
  const parts = value.split('|').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return {
    receiverName: parts[0],
    receiverDocument: parts[1],
    receiverRelationship: parts[2]
  };
};

const receiverInstructions = (cte) => [
  `Código do CT-e ${cte} identificado.`,
  'Responda em uma única mensagem no formato:',
  'NOME | DOCUMENTO | GRAU/RELAÇÃO',
  'Exemplo: João da Silva | 12345678900 | Porteiro',
  'Se o comprovante não tiver esses dados, responda PULAR.'
].join('\n');

const safeReply = async (to, text) => {
  try {
    await sendText(to, text);
  } catch (error) {
    console.error('[whatsapp:reply]', error);
  }
};

const processImage = async (image) => {
  if (!await store.claimMessage(image.messageId)) return;
  try {
    const existing = await store.getPendingDelivery(image.senderPhone);
    if (existing) {
      await store.markMessageDone(image.messageId);
      await safeReply(image.senderPhone,
        'Existe outro comprovante aguardando os dados do recebedor. Responda os dados solicitados ou PULAR antes de enviar outra foto.');
      return;
    }

    const media = await downloadMedia(image.mediaId);
    const barcode = await readBarcode(media.bytes);
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
    await store.savePendingDelivery(image.senderPhone, {
      imageMessageId: image.messageId,
      mediaId: image.mediaId,
      timestamp: image.timestamp,
      driverName: image.driverName,
      barcode,
      resolved,
      location
    });
    await safeReply(image.senderPhone, receiverInstructions(barcode.text));
  } catch (error) {
    console.error('[whatsapp:proof]', { messageId: image.messageId, error });
    await store.releaseMessage(image.messageId).catch(() => {});
    await safeReply(image.senderPhone,
      'Não foi possível registrar este comprovante. A baixa não foi confirmada; confira a foto e tente novamente.');
  }
};

const processText = async (text) => {
  const pending = await store.getPendingDelivery(text.senderPhone);
  if (!pending || !await store.claimMessage(text.messageId)) return;

  const proof = parseReceiverReply(text.body);
  if (!proof) {
    await store.markMessageDone(text.messageId);
    await safeReply(text.senderPhone, receiverInstructions(pending.barcode.text));
    return;
  }

  let occurrenceCreated = false;
  try {
    const media = await downloadMedia(pending.mediaId);
    const latestLocation = await store.takeLocation(text.senderPhone);
    const occurrence = await createDeliveryOccurrence({
      minuta: pending.resolved.minuta,
      clientCnpj: pending.resolved.clientCnpj,
      timestamp: formatTimestamp(pending.timestamp),
      driverName: pending.driverName,
      senderPhone: text.senderPhone,
      messageId: pending.imageMessageId,
      image: media.bytes,
      mimeType: media.mimeType,
      proof,
      barcode: pending.barcode,
      location: latestLocation || pending.location
    });
    occurrenceCreated = true;
    await store.completePendingDelivery(
      text.senderPhone,
      pending.imageMessageId,
      text.messageId
    );
    await safeReply(text.senderPhone, occurrence.alreadyRegistered
      ? `A entrega da minuta ${pending.resolved.minuta} já estava baixada na Brudam. O comprovante não foi anexado porque a ocorrência código 1 não pode ser repetida.`
      : `Entrega registrada com sucesso. Minuta ${pending.resolved.minuta}.`);
  } catch (error) {
    console.error('[whatsapp:receiver]', { messageId: text.messageId, error });
    if (!occurrenceCreated) await store.releaseMessage(text.messageId).catch(() => {});
    await safeReply(text.senderPhone,
      'Não foi possível registrar este comprovante. A baixa não foi confirmada; tente enviar os dados novamente.');
  }
};

const processWebhook = async (payload) => {
  const { images, locations, texts } = parseWebhook(payload);
  await Promise.all(locations.map((item) => store.saveLocation(item.senderPhone, item.location)));
  await Promise.all(images.map(processImage));
  await Promise.all(texts.map(processText));
};

module.exports = { formatTimestamp, parseWebhook, parseReceiverReply, processWebhook };
