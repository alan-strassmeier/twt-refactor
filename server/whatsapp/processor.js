const { readBarcode } = require('./barcode');
const {
  resolveMinutaAndClient,
  createDeliveryOccurrence,
  isDeliveryAlreadyRegistered
} = require('./brudam');
const { downloadMedia, sendText, sendButtons, sendImage, sendFlow } = require('./meta');
const store = require('./redis-store');

const START_DELIVERY = 'start_delivery';
const HUMAN_CONTACT = 'human_contact';
const AWAITING_PHOTO = 'awaiting_photo';
const AWAITING_RECEIVER = 'awaiting_receiver';
const RECEIVER_FLOW_SCREEN = 'DADOS_RECEBEDOR';
const LEGACY_EXAMPLE_IMAGE_URL =
  'https://www.twt.com.br/assets/whatsapp/comprovante-exemplo.jpeg';
const VERSIONED_EXAMPLE_IMAGE_URL =
  'https://www.twt.com.br/assets/whatsapp/comprovante-exemplo-5b4e9145.jpeg';
const exampleImageUrl = (configuredUrl) => {
  const value = String(configuredUrl || '').trim();
  return value && value !== LEGACY_EXAMPLE_IMAGE_URL
    ? value
    : VERSIONED_EXAMPLE_IMAGE_URL;
};
const EXAMPLE_IMAGE_URL = exampleImageUrl(process.env.WHATSAPP_EXAMPLE_IMAGE_URL);
const HUMAN_CONTACT_MESSAGE = 'Olá, gostaria de falar sobre uma entrega';
const BRUDAM_UNAVAILABLE_MESSAGE =
  'O sistema da Brudam está com uma instabilidade momentânea. A baixa não foi confirmada; tente novamente em alguns minutos.';
const humanContactUrl = () =>
  `https://wa.me/555193162358?text=${encodeURIComponent(HUMAN_CONTACT_MESSAGE)}`;

const processingFailureMessage = (error, fallback) =>
  error?.code === 'BRUDAM_UNAVAILABLE' ? BRUDAM_UNAVAILABLE_MESSAGE : fallback;

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
  const flowReplies = [];
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
        const flowReply = message.interactive?.nfm_reply;
        if (message.type === 'interactive' && flowReply?.response_json) {
          flowReplies.push({
            ...common,
            responseJson: flowReply.response_json
          });
        }
      }
    }
  }
  return { images, locations, texts, actions, flowReplies };
};

const parseReceiverReply = (body) => {
  const lines = String(body || '').replace(/\r/g, '').split('\n').filter((line) => line.trim());
  if (lines.length !== 3) return null;
  const [receiverName, receiverDocument, receiverRelationship] = lines.map((line) => line.trim());
  if (!receiverName || !receiverDocument || !receiverRelationship) return null;
  if (receiverName.length > 120 || receiverDocument.length > 40 || receiverRelationship.length > 80) return null;
  return { receiverName, receiverDocument, receiverRelationship };
};

const parseReceiverFlowReply = (responseJson) => {
  let payload = responseJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const receiverName = String(payload.nome_recebedor || '').trim();
  const receiverDocument = String(payload.documento_recebedor || '').trim();
  const receiverRelationship = String(payload.grau_relacao || '').trim();
  if (!receiverName || !receiverDocument || !receiverRelationship) return null;
  if (receiverName.length > 120 || receiverDocument.length > 40 || receiverRelationship.length > 80) return null;
  return {
    proof: { receiverName, receiverDocument, receiverRelationship },
    flowToken: String(payload.flow_token || '').trim()
  };
};

const receiverFlowId = () => {
  const flowId = String(process.env.WHATSAPP_RECEIVER_FLOW_ID || '').trim();
  if (!flowId) throw new Error('WHATSAPP_RECEIVER_FLOW_ID não configurado.');
  return flowId;
};

const flowTokenFor = (imageMessageId) => `delivery:${imageMessageId}`;

const receiverInstructions = (cte) => [
  `Código do CT-e ${cte} identificado.`,
  'Envie os dados do recebedor em uma única mensagem, usando três linhas nesta ordem: nome, documento e grau/relação.',
  '',
  'João da Silva',
  '12345678900',
  'Porteiro',
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
  'Por favor, envie uma foto igual ao exemplo acima.'
);

const sendReceiverFlow = (to, cte, imageMessageId) => sendFlow(to, {
  flowId: receiverFlowId(),
  flowToken: flowTokenFor(imageMessageId),
  screen: RECEIVER_FLOW_SCREEN,
  cta: 'Informar recebedor',
  body: [
    `Código do CT-e ${cte} identificado.`,
    'Preencha os três dados obrigatórios do recebedor no formulário.'
  ].join('\n')
});

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
        `Para falar com nossa equipe de atendimento, toque no link:\n${humanContactUrl()}`);
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

    const alreadyRegistered = await store.hasDeliveredMinuta(resolved.minuta) ||
      await isDeliveryAlreadyRegistered(resolved.minuta);
    if (alreadyRegistered) {
      await store.markDeliveredMinuta(resolved.minuta);
      await store.markMessageDone(image.messageId);
      await store.clearConversationState(image.senderPhone);
      await safeReply(image.senderPhone,
        `A entrega da minuta ${resolved.minuta} já foi baixada anteriormente. Não é necessário informar os dados do recebedor.`);
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
    await sendReceiverFlow(image.senderPhone, barcode.text, image.messageId);
  } catch (error) {
    console.error('[whatsapp:proof]', { messageId: image.messageId, error });
    await store.clearPendingDelivery(image.senderPhone).catch(() => {});
    await store.saveConversationState(image.senderPhone, AWAITING_PHOTO).catch(() => {});
    await store.releaseMessage(image.messageId).catch(() => {});
    await safeReply(image.senderPhone, processingFailureMessage(
      error,
      'Não foi possível analisar este comprovante ou abrir o formulário. A baixa não foi confirmada; envie a foto novamente.'
    ));
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
    await store.markDeliveredMinuta(pending.resolved.minuta);
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
    await safeReply(text.senderPhone, processingFailureMessage(
      error,
      'Não foi possível registrar este comprovante. A baixa não foi confirmada; envie os dados novamente.'
    ));
  }
};

const processReceiverFlowReply = async (reply) => {
  const pending = await store.getPendingDelivery(reply.senderPhone);
  if (!pending) {
    if (!await store.claimMessage(reply.messageId)) return;
    await store.markMessageDone(reply.messageId);
    await safeReply(reply.senderPhone,
      'Este formulário não está mais vinculado a um comprovante. Inicie uma nova baixa e envie a foto novamente.');
    return;
  }

  if (!await store.claimMessage(reply.messageId)) return;
  const parsed = parseReceiverFlowReply(reply.responseJson);
  if (!parsed) {
    await store.markMessageDone(reply.messageId);
    await safeReply(reply.senderPhone,
      'Não recebi todos os dados obrigatórios. Abra o formulário novamente e preencha os três campos.');
    await sendReceiverFlow(reply.senderPhone, pending.barcode.text, pending.imageMessageId).catch(() => {});
    return;
  }

  if (parsed.flowToken && parsed.flowToken !== flowTokenFor(pending.imageMessageId)) {
    await store.markMessageDone(reply.messageId);
    await safeReply(reply.senderPhone,
      'Este formulário pertence a outro comprovante. Use o formulário mais recente enviado nesta conversa.');
    return;
  }

  await processReceiverText({
    ...reply,
    body: [
      parsed.proof.receiverName,
      parsed.proof.receiverDocument,
      parsed.proof.receiverRelationship
    ].join('\n')
  }, pending);
};

const normalizedChoice = (body) => String(body || '').trim().toLocaleLowerCase('pt-BR');

const processText = async (text) => {
  const pending = await store.getPendingDelivery(text.senderPhone);
  if (pending) {
    if (!await store.claimMessage(text.messageId)) return;
    try {
      await sendReceiverFlow(text.senderPhone, pending.barcode.text, pending.imageMessageId);
      await store.markMessageDone(text.messageId);
      await safeReply(text.senderPhone,
        'Para continuar, preencha o formulário enviado acima. Os três campos são obrigatórios.');
    } catch (error) {
      console.error('[whatsapp:flow]', { messageId: text.messageId, error });
      await store.releaseMessage(text.messageId).catch(() => {});
      await safeReply(text.senderPhone,
        'Não consegui abrir o formulário agora. Tente enviar uma mensagem novamente.');
    }
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
        `Para falar com nossa equipe de atendimento, toque no link:\n${humanContactUrl()}`);
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
  const { images, locations, texts, actions, flowReplies } = parseWebhook(payload);
  await Promise.all(locations.map((item) => store.saveLocation(item.senderPhone, item.location)));
  await Promise.all(actions.map(processAction));
  await Promise.all(images.map(processImage));
  await Promise.all(flowReplies.map(processReceiverFlowReply));
  await Promise.all(texts.map(processText));
};

module.exports = {
  formatTimestamp,
  greetingFor,
  greetingMessage,
  humanContactUrl,
  parseWebhook,
  parseReceiverReply,
  parseReceiverFlowReply,
  receiverInstructions,
  exampleImageUrl,
  processingFailureMessage,
  flowTokenFor,
  processWebhook
};
