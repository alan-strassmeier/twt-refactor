const graphBase = () =>
  `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v25.0'}`;

const accessToken = () => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN não configurado.');
  return token;
};

const downloadMedia = async (mediaId) => {
  const headers = { Authorization: `Bearer ${accessToken()}` };
  const metadataResponse = await fetch(`${graphBase()}/${encodeURIComponent(mediaId)}`, {
    headers,
    signal: AbortSignal.timeout(15000)
  });
  if (!metadataResponse.ok) throw new Error(`Meta não retornou a mídia (${metadataResponse.status}).`);
  const metadata = await metadataResponse.json();
  const mediaResponse = await fetch(metadata.url, {
    headers,
    signal: AbortSignal.timeout(30000)
  });
  if (!mediaResponse.ok) throw new Error(`Falha ao baixar a foto (${mediaResponse.status}).`);
  const bytes = Buffer.from(await mediaResponse.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024) throw new Error('A foto ultrapassa o limite de 20 MB.');
  return {
    bytes,
    mimeType: metadata.mime_type || mediaResponse.headers.get('content-type') || 'image/jpeg'
  };
};

const sendMessage = async (to, message) => {
  if (String(process.env.WHATSAPP_SEND_REPLIES || 'true').toLowerCase() !== 'true') return;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID não configurado.');
  const response = await fetch(`${graphBase()}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...message }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Falha ao responder no WhatsApp (${response.status}): ${await response.text()}`);
};

const sendText = (to, body) =>
  sendMessage(to, { type: 'text', text: { body } });

const sendButtons = (to, body, buttons) => sendMessage(to, {
  type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: body },
    action: {
      buttons: buttons.map((button) => ({
        type: 'reply',
        reply: { id: button.id, title: button.title }
      }))
    }
  }
});

const sendImage = (to, link, caption) => sendMessage(to, {
  type: 'image',
  image: { link, caption }
});

module.exports = { downloadMedia, sendText, sendButtons, sendImage };
