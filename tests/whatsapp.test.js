const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');
const { normalizeCteKey, selectCteBarcode } = require('../server/whatsapp/barcode');
const {
  buildCostsQuery,
  isDuplicateOccurrence,
  hasDeliveryOccurrence
} = require('../server/whatsapp/brudam');
const { sendButtons, sendImage, sendFlow } = require('../server/whatsapp/meta');
const {
  formatTimestamp,
  greetingFor,
  greetingMessage,
  humanContactUrl,
  parseWebhook,
  parseReceiverReply,
  parseReceiverFlowReply,
  flowTokenFor,
  exampleImageUrl,
  receiverInstructions
} = require('../server/whatsapp/processor');
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

test('extrai nome, imagem, localização e botão do payload', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '5551999999999', profile: { name: 'Motorista' } }],
    messages: [
      { from: '5551999999999', id: 'loc-1', timestamp: '1', type: 'location', location: { latitude: -29, longitude: -51 } },
      { from: '5551999999999', id: 'img-1', timestamp: '1784233954', type: 'image', image: { id: 'media-1', caption: 'entrega' } },
      { from: '5551999999999', id: 'text-1', timestamp: '1784233955', type: 'text', text: { body: 'Olá' } },
      { from: '5551999999999', id: 'button-1', timestamp: '1784233956', type: 'interactive', interactive: {
        type: 'button_reply', button_reply: { id: 'start_delivery', title: 'Dar baixa na entrega' }
      } },
      { from: '5551999999999', id: 'flow-1', timestamp: '1784233957', type: 'interactive', interactive: {
        type: 'nfm_reply', nfm_reply: {
          response_json: '{"nome_recebedor":"Ana","documento_recebedor":"123","grau_relacao":"Porteira","flow_token":"delivery:img-1"}'
        }
      } }
    ]
  } }] }] };
  const parsed = parseWebhook(payload);
  assert.equal(parsed.images[0].driverName, 'Motorista');
  assert.equal(parsed.images[0].mediaId, 'media-1');
  assert.deepEqual(parsed.locations[0].location, { latitude: -29, longitude: -51 });
  assert.equal(parsed.texts[0].body, 'Olá');
  assert.equal(parsed.texts[0].driverName, 'Motorista');
  assert.equal(parsed.actions[0].actionId, 'start_delivery');
  assert.match(parsed.flowReplies[0].responseJson, /nome_recebedor/);
});

test('interpreta os três dados obrigatórios em linhas separadas', () => {
  assert.deepEqual(parseReceiverReply([
    'João da Silva',
    '12345678900',
    'Porteiro'
  ].join('\n')), {
    receiverName: 'João da Silva',
    receiverDocument: '12345678900',
    receiverRelationship: 'Porteiro'
  });
  assert.equal(parseReceiverReply('PULAR'), null);
  assert.equal(parseReceiverReply('João\n123'), null);
  assert.equal(parseReceiverReply('João\n123\nPorteiro\nInformação extra'), null);
  assert.match(receiverInstructions('123'), /Todos os três campos são obrigatórios/);
});

test('interpreta os campos obrigatórios devolvidos pelo Flow', () => {
  assert.deepEqual(parseReceiverFlowReply(JSON.stringify({
    nome_recebedor: 'Ana Silva',
    documento_recebedor: '12345678900',
    grau_relacao: 'Porteira',
    flow_token: 'delivery:img-1'
  })), {
    proof: {
      receiverName: 'Ana Silva',
      receiverDocument: '12345678900',
      receiverRelationship: 'Porteira'
    },
    flowToken: 'delivery:img-1'
  });
  assert.equal(parseReceiverFlowReply('{"nome_recebedor":"Ana"}'), null);
  assert.equal(flowTokenFor('wamid.123'), 'delivery:wamid.123');
});

test('saudação usa o período do dia e o nome do WhatsApp', () => {
  process.env.APP_TIMEZONE = 'America/Sao_Paulo';
  assert.equal(greetingFor(Date.parse('2026-07-23T12:00:00Z') / 1000), 'Bom dia');
  assert.equal(greetingFor(Date.parse('2026-07-23T18:00:00Z') / 1000), 'Boa tarde');
  assert.equal(greetingFor(Date.parse('2026-07-24T01:00:00Z') / 1000), 'Boa noite');
  assert.match(greetingMessage('Alan', Date.parse('2026-07-23T18:00:00Z') / 1000), /^Boa tarde, Alan!/);
});

test('link do atendimento humano abre com mensagem preenchida', () => {
  const url = new URL(humanContactUrl());
  assert.equal(url.hostname, 'wa.me');
  assert.equal(url.pathname, '/555193162358');
  assert.equal(url.searchParams.get('text'), 'Olá, gostaria de falar sobre uma entrega');
});

test('monta mensagens de botões e imagem no formato da Meta', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  process.env.WHATSAPP_ACCESS_TOKEN = 'token-de-teste';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-id';
  process.env.WHATSAPP_SEND_REPLIES = 'true';
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response('{}', { status: 200 });
  };
  try {
    await sendButtons('5551999999999', 'Como podemos ajudar?', [
      { id: 'start_delivery', title: 'Dar baixa na entrega' },
      { id: 'human_contact', title: 'Entre em contato' }
    ]);
    await sendImage('5551999999999', 'https://www.twt.com.br/exemplo.jpeg', 'Tire uma foto.');
    await sendFlow('5551999999999', {
      flowId: '28036008142734184',
      flowToken: 'delivery:wamid.123',
      screen: 'DADOS_RECEBEDOR',
      body: 'Preencha os dados.',
      cta: 'Informar recebedor'
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(requests[0].body.type, 'interactive');
  assert.equal(requests[0].body.interactive.action.buttons.length, 2);
  assert.equal(requests[1].body.type, 'image');
  assert.equal(requests[1].body.image.link, 'https://www.twt.com.br/exemplo.jpeg');
  assert.equal(requests[2].body.interactive.type, 'flow');
  assert.equal(requests[2].body.interactive.action.parameters.flow_id, '28036008142734184');
  assert.equal(requests[2].body.interactive.action.parameters.flow_action_payload.screen, 'DADOS_RECEBEDOR');
  assert.equal(requests[2].body.interactive.action.parameters.flow_token, 'delivery:wamid.123');
});

test('converte horário do WhatsApp para São Paulo', () => {
  process.env.APP_TIMEZONE = 'America/Sao_Paulo';
  assert.equal(formatTimestamp(Date.parse('2026-07-14T16:31:11Z') / 1000), '2026-07-14 13:31:11');
});

test('consulta custos pelo parâmetro simples do número do CT-e', () => {
  assert.equal(buildCostsQuery('51057251'), 'numero=51057251&limit=2');
});

test('identifica ocorrência código 1 já inserida na minuta', () => {
  assert.equal(isDuplicateOccurrence({
    status: 1,
    data: [{
      status: null,
      messages: [{
        status: 0,
        codigo: 1,
        message: 'Ocorrência já foi inserida nesta minuta!'
      }]
    }]
  }), true);
  assert.equal(isDuplicateOccurrence({
    status: 1,
    data: [{ status: 1, messages: [] }]
  }), false);
});

test('troca automaticamente a URL antiga da imagem pela versão sem cache', () => {
  assert.equal(
    exampleImageUrl('https://www.twt.com.br/assets/whatsapp/comprovante-exemplo.jpeg'),
    'https://www.twt.com.br/assets/whatsapp/comprovante-exemplo-5b4e9145.jpeg'
  );
  assert.equal(
    exampleImageUrl('https://cdn.example.com/comprovante.jpeg'),
    'https://cdn.example.com/comprovante.jpeg'
  );
});

test('identifica baixa existente no retorno de rastreamento', () => {
  assert.equal(hasDeliveryOccurrence({
    status: 1,
    data: [{
      status: 1,
      dados: [{
        status: 1,
        descricao: 'ENTREGA REALIZADA NORMALMENTE'
      }]
    }]
  }), true);
  assert.equal(hasDeliveryOccurrence({
    status: 1,
    data: [{
      status: 1,
      dados: [{
        status: 2,
        descricao: 'EM TRÂNSITO'
      }]
    }]
  }), false);
  assert.equal(hasDeliveryOccurrence({
    status: 1,
    data: [{
      status: 0,
      message: 'Erro na consulta do documento.',
      dados: null
    }]
  }), false);
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
