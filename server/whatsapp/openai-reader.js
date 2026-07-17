const OpenAIModule = require('openai');
const OpenAI = OpenAIModule.default || OpenAIModule.OpenAI || OpenAIModule;

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    receiver_name: { type: ['string', 'null'] },
    receiver_document: { type: ['string', 'null'], description: 'CPF ou RG manuscrito do recebedor.' },
    receiver_relationship: { type: ['string', 'null'], description: 'Grau ou relação, somente se estiver escrito.' }
  },
  required: ['receiver_name', 'receiver_document', 'receiver_relationship']
};

let client;

const getClient = () => {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada.');
  if (!client) client = new OpenAI({ apiKey });
  return client;
};

const readReceiver = async (bytes, mimeType, caption = '') => {
  const response = await getClient().responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            'Leia somente os campos manuscritos do recebedor neste comprovante de entrega brasileiro.',
            'Não invente nem complete texto ilegível. Use null quando não houver certeza.',
            'Não confunda o recebedor com motorista, remetente, destinatário ou nomes impressos de empresas.',
            `Legenda enviada pelo motorista: ${caption || '(sem legenda)'}`
          ].join('\n')
        },
        {
          type: 'input_image',
          image_url: `data:${mimeType};base64,${bytes.toString('base64')}`,
          detail: 'high'
        }
      ]
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'delivery_receiver',
        strict: true,
        schema
      }
    }
  });

  const value = JSON.parse(response.output_text);
  return {
    receiverName: value.receiver_name || null,
    receiverDocument: value.receiver_document || null,
    receiverRelationship: value.receiver_relationship || null
  };
};

module.exports = { readReceiver };
