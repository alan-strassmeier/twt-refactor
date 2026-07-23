const { readBarcode } = require('./barcode');
const { resolveMinutaAndClient, createDeliveryOccurrence } = require('./brudam');
const { downloadMedia, sendText, sendButtons, sendImage } = require('./meta');
const store = require('./redis-store');

const START_DELIVERY = 'start_delivery';
const HUMAN_CONTACT = 'human_contact';
const AWAITING_PHOTO = 'awaiting_photo';
const AWAITING_RECEIVER = 'awaiting_receiver';
const EXAMPLE_IMAGE_URL = process.env.WHATSAPP_EXAMPLE_IMAGE_URL ||
  'https://www.twt.com.br/assets/whatsapp/comprovante-exemplo.jpeg';
const HUMAN_WHATSAPP_URL = 'https://wa.me/555193162358';

const formatTimestamp = (epochSeconds) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
};

const greetingFor = (epochSeconds) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE || 'America/Sao_Paulo',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date((epochSeconds || Date.now() / 1000) * 1000));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
};

const greetingMessage = (driverName, epochSeconds) => [
  `${greetingFor(epochSeconds)}, ${driverName || 'motorista'}!`,
  'Bem-vindo(a) ao atendimento DSL para baixa de entregas.',
  'Como podemos ajudar?'
].join('\n');

const contactForMessage = (contacts, senderPhone) => {
  const contact = contacts.find((item) => item.wa_id === senderPhone) || contacts[0];
  const name = String(contact?.profile?.name || '').trim();
  return name || 'motorista';
};

const commonMessage = (message, contacts) => {
  const senderPhone = String(message.from || '');
  return {
    messageId: String(message.id || ''),
    senderPhone,
    driverName: contactForMessage(contacts, senderPhone),
    timestamp: Number(message.timestamp) || Math.floor(Date.now() / 1000)
  };
};

const parseWebhook = (payload) => {
  const images = [];
  const locations = [];
  const texts = [];
  const actions = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        const common = commonMessage(message, contacts);
        if (!common.senderPhone || !common.messageId) continue;
        if (message.type === 'location') {
          const latitude = Number(message.location?.latitude);
          const longitude = Number(message.location?.longitude);
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            locations.push({ ...common, location: { latitude, longitude } });
          }
        }
        if (message.type === 'image' && message.image?.id) {
          images.push({
            ...common,
            mediaId: String(message.image.id),
            caption: String(message.image.caption || '')
          });
        }
        if (message.type === 'text' && message.text?.body) {
          texts.push({ ...common, body: String(message.text.body).trim() });
        }
        const buttonReply = message.interactive?.button_reply;
        if (message.type === 'interactive' && buttonReply?.id) {
          actions.push({
            ...common,
            actionId: String(buttonReply.id),
            title: String(buttonReply.title || '')
          });
        }
        if (message.type === 'button' && message.button?.payload) {
          actions.push({
            ...common,
            actionId: String(message.button.payload),
            title: String(message.button.text || '')
          });
        }
      }
    }
  }
  return { images, locations, texts, actions };
};

const parseReceiverReply = (body) => {
  const fields = {};
  const aliases = {
    nome: 'receiverName',
    documento: 'receiverDocument',
    'grau/relação': 'receiverRelationship',
    'grau/relacao': 'receiverRelationship',
    relação: 'receiverRelationship',
    relacao: 'receiverRelationship'
  };
  const lines = String(body || '').replace(/\r/g, '').split('\n').filter((line) => line.trim());
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) return null;
    const key = aliases[match[1].trim().toLocaleLowerCase('pt-BR')];
    const value = match[2].trim();
    if (!key || !value || fields[key]) return null;
    fields[key] = value;
  }
  if (!fields.receiverName || !fields.receiverDocument || !fields.receiverRelationship) return null;
  if (fields.receiverName.length > 120 || fields.receiverDocument.length > 40 ||
      fields.receiverRelationship.length > 80) return null;
  return fields;
};

const receiverInstructions = (cte) => [
  `Código do CT-e ${cte} identificado.`,
  'Envie os dados do recebedor em uma única mensagem, usando uma linha para cada informação:',
  '',
  'Nome: João da Silva',
  'Documento: 12345678900',
  'Grau/relação: Porteiro',
  '',
  'Todos os três campos são obrigatórios.'
].join('\n');

const sendMenu = async (message) => {
  await store.saveConversationState(message.senderPhone, 'menu');
  await sendButtons(
    message.senderPhone,
    greetingMessage(message.driverName, message.timestamp),
    [
      { id: START_DELIVERY, title: 'Dar baixa na entrega' },
      { id: HUMAN_CONTACT, title: 'Entre em contato' }
    ]
  );
};

const sendExample = (to) => sendImage(
  to,
  EXAMPLE_IMAGE_URL,
  'Por favor, tire uma foto igual ao exemplo acima.'
);

const safeReply = async (to, text) => {
  try {
    await sendText(to, text);
  } catch (error) {
    console.error('[whatsapp:reply]', error);
  }
};

const processAction = async (action) => {
  if (!await store.claimMessage(action.messageId)) return;
  try {
    if (action.actionId === START_DELIVERY) {
      await store.saveConversationState(action.senderPhone, AWAITING_PHOTO);
      await sendExample(action.senderPhone);
    } else if (action.actionId === HUMAN_CONTACT) {
      await store.clearConversationState(action.senderPhone);
      await sendText(action.senderPhone,
        `Para falar com nossa equipe de atendimento, toque no link:\n${HUMAN_WHATSAPP_URL}`);
    } else {
      await sendMenu(action);
    }
    await store.markMessageDone(action.messageId);
  } catch (error) {
    console.error('[whatsapp:action]', { messageId: action.messageId, error });
    await store.releaseMessage(action.messageId).catch(() => {});
  }
};

const processImage = async (image) => {
  if (!await store.claimMessage(image.messageId)) return;
  try {
    const existing = await store.getPendingDelivery(image.senderPhone);
    if (existing) {
      await store.markMessageDone(image.messageId);
      await safeReply(image.senderPhone,
        'Existe outro comprovante aguardando os dados obrigatórios do recebedor. Envie os três dados solicitados antes de mandar outra foto.');
      return;
    }

    const state = await store.getConversationState(image.senderPhone);
    if (state !== AWAITING_PHOTO) {
      await store.markMessageDone(image.messageId);
      await sendMenu(image);
      return;
    }

    const media = await downloadMedia(image.mediaId);
    const barcode = await readBarcode(media.bytes);
    if (!barcode) {
      await store.markMessageDone(image.messageId);
      await safeReply(image.senderPhone,
        'Não consegui identificar o código de barras corretamente. Tire outra foto com o código inteiro, nítido e sem reflexo e envie novamente.');
      return;
    }

    const cteIdentifier = barcode.text.replace(/\D/g, '');
    const resolved = await resolveMinutaAndClient(cteIdentifier);
    if (!resolved) {
      await store.markMessageDone(image.messageId);
      await safeReply(image.senderPhone,
        `Identifiquei o CT-e ${barcode.text}, mas não encontrei uma única minuta correspondente. Confira o comprovante e envie uma nova foto.`);
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
    await store.saveConversationState(image.senderPhone, AWAITING_RECEIVER);
    await safeReply(image.senderPhone, receiverInstructions(barcode.text));
  } catch (error) {
    console.error('[whatsapp:proof]', { messageId: image.messageId, error });
    await store.releaseMessage(image.messageId).catch(() => {});
    await safeReply(image.senderPhone,
      'Não foi possível analisar este comprovante. A baixa não foi confirmada; envie a foto novamente.');
  }
};

const processReceiverText = async (text, pending) => {
  const proof = parseReceiverReply(text.body);
  if (!proof) {
    await store.markMessageDone(text.messageId);
    await safeReply(text.senderPhone,
      `Não consegui identificar os três dados obrigatórios.\n\n${receiverInstructions(pending.barcode.text)}`);
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
      ? `A entrega da minuta ${pending.resolved.minuta} já estava baixada no sistema. A baixa já foi confirmada.`
      : `Entrega registrada com sucesso. Minuta ${pending.resolved.minuta}.`);
  } catch (error) {
    console.error('[whatsapp:receiver]', { messageId: text.messageId, error });
    if (!occurrenceCreated) await store.releaseMessage(text.messageId).catch(() => {});
    await safeReply(text.senderPhone,
      'Não foi possível registrar este comprovante. A baixa não foi confirmada; envie os dados novamente.');
  }
};

const normalizedChoice = (body) => String(body || '').trim().toLocaleLowerCase('pt-BR');

const processText = async (text) => {
  const pending = await store.getPendingDelivery(text.senderPhone);
  if (pending) {
    if (!await store.claimMessage(text.messageId)) return;
    await processReceiverText(text, pending);
    return;
  }

  if (!await store.claimMessage(text.messageId)) return;
  try {
    const choice = normalizedChoice(text.body);
    const state = await store.getConversationState(text.senderPhone);
    if (choice === 'dar baixa na entrega') {
      await store.saveConversationState(text.senderPhone, AWAITING_PHOTO);
      await sendExample(text.senderPhone);
    } else if (choice === 'entre em contato' || choice === 'entre em contato conosco') {
      await store.clearConversationState(text.senderPhone);
      await sendText(text.senderPhone,
        `Para falar com nossa equipe de atendimento, toque no link:\n${HUMAN_WHATSAPP_URL}`);
    } else if (state === AWAITING_PHOTO) {
      await sendExample(text.senderPhone);
    } else {
      await sendMenu(text);
    }
    await store.markMessageDone(text.messageId);
  } catch (error) {
    console.error('[whatsapp:text]', { messageId: text.messageId, error });
    await store.releaseMessage(text.messageId).catch(() => {});
  }
};

const processWebhook = async (payload) => {
  const { images, locations, texts, actions } = parseWebhook(payload);
  await Promise.all(locations.map((item) => store.saveLocation(item.senderPhone, item.location)));
  await Promise.all(actions.map(processAction));
  await Promise.all(images.map(processImage));
  await Promise.all(texts.map(processText));
};

module.exports = {
  formatTimestamp,
  greetingFor,
  greetingMessage,
  parseWebhook,
  parseReceiverReply,
  receiverInstructions,
  processWebhook
};
