const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');
const sharp = require('sharp');
const deliveryTimeFlow = require('../docs/whatsapp-flow-data-hora.json');
const {
  normalizeCteKey,
  selectCteBarcode,
  enhanceForBarcode
} = require('../server/whatsapp/barcode');
const {
  buildCostsQuery,
  isDuplicateOccurrence,
  isCiaIntegrationDelivery,
  hasDeliveryOccurrence
} = require('../server/whatsapp/brudam');
const { sendButtons, sendImage, sendFlow } = require('../server/whatsapp/meta');
const {
  EXAMPLE_CAPTION,
  formatTimestamp,
  timestampForPending,
  greetingFor,
  greetingMessage,
  humanContactUrl,
  parseWebhook,
  parseReceiverReply,
  parseReceiverFlowReply,
  parseDeliveryTimeFlowReply,
  flowTokenFor,
  deliveryTimeFlowTokenFor,
  isCancelCommand,
  exampleImageUrl,
  processingFailureMessage,
  receiverInstructions
} = require('../server/whatsapp/processor');
const { verifySignature } = require('../server/whatsapp/signature');
const {
  DELIVERY_ATTEMPT_TTL_SECONDS,
  saveLocation,
  saveConversationState,
  saveDeliveryTimestamp,
  savePendingDelivery,
  clearDeliveryAttempt
} = require('../server/whatsapp/redis-store');

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

test('interpreta data e horário anteriores ao momento atual', () => {
  process.env.APP_TIMEZONE = 'America/Sao_Paulo';
  const now = Date.parse('2026-08-12T18:00:00Z') / 1000;
  assert.deepEqual(parseDeliveryTimeFlowReply(JSON.stringify({
    data_entrega: '2026-08-12',
    hora_entrega: '14',
    minuto_entrega: '59',
    flow_token: 'delivery-time:button-1'
  }), now), {
    deliveryTimestamp: '2026-08-12 14:59:00',
    flowToken: 'delivery-time:button-1'
  });
  assert.equal(deliveryTimeFlowTokenFor('button-1'), 'delivery-time:button-1');
});

test('rejeita data ou horário futuro e valores inválidos', () => {
  process.env.APP_TIMEZONE = 'America/Sao_Paulo';
  const now = Date.parse('2026-08-12T18:00:00Z') / 1000;
  assert.equal(parseDeliveryTimeFlowReply({
    data_entrega: '2026-08-13', hora_entrega: '10', minuto_entrega: '00'
  }, now).error, 'future');
  assert.equal(parseDeliveryTimeFlowReply({
    data_entrega: '2026-08-12', hora_entrega: '15', minuto_entrega: '01'
  }, now).error, 'future');
  assert.equal(parseDeliveryTimeFlowReply({
    data_entrega: '2026-02-30', hora_entrega: '10', minuto_entrega: '00'
  }, now), null);
  assert.equal(parseDeliveryTimeFlowReply({
    data_entrega: '2026-08-12', hora_entrega: '24', minuto_entrega: '00'
  }, now), null);
});

test('Flow de data e horário usa calendário limitado e seletores completos', () => {
  const screen = deliveryTimeFlow.screens[0];
  const form = screen.layout.children.find((item) => item.type === 'Form');
  const date = form.children.find((item) => item.name === 'data_entrega');
  const hours = form.children.find((item) => item.name === 'hora_entrega');
  const minutes = form.children.find((item) => item.name === 'minuto_entrega');
  const footer = screen.layout.children.find((item) => item.type === 'Footer');
  assert.equal(screen.id, 'DATA_HORA_ENTREGA');
  assert.equal(date['max-date'], '${data.max_date}');
  assert.equal(hours['data-source'].length, 24);
  assert.equal(minutes['data-source'].length, 60);
  assert.equal(footer['on-click-action'].payload.data_entrega, '${form.data_entrega}');
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

test('orienta o cancelamento junto da foto de exemplo', () => {
  assert.equal(
    EXAMPLE_CAPTION,
    [
      'Por favor, envie uma foto igual ao exemplo acima.',
      'Caso deseje cancelar a baixa, envie uma mensagem com *cancelar* e retorne ao início.'
    ].join('\n\n')
  );
  assert.equal(isCancelCommand(' cancelar '), true);
  assert.equal(isCancelCommand('CANCELAR'), true);
  assert.equal(isCancelCommand('não cancelar'), false);
});

test('mantém os dados temporários da baixa por 15 minutos e permite limpá-los juntos', async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const commands = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token-de-teste';
  global.fetch = async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };
  try {
    await saveLocation('5551999999999', { latitude: -29, longitude: -51 });
    await saveConversationState('5551999999999', 'awaiting_photo');
    await saveDeliveryTimestamp('5551999999999', '2026-08-13 10:00:00');
    await savePendingDelivery('5551999999999', { imageMessageId: 'img-1' });
    await clearDeliveryAttempt('5551999999999');
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }

  assert.equal(DELIVERY_ATTEMPT_TTL_SECONDS, 900);
  for (const command of commands.slice(0, 4)) {
    assert.deepEqual(command.slice(-2), ['EX', 900]);
  }
  assert.deepEqual(commands[4], [
    'DEL',
    'whatsapp:pending:5551999999999',
    'whatsapp:state:5551999999999',
    'whatsapp:delivery-timestamp:5551999999999',
    'whatsapp:location:5551999999999'
  ]);
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
      cta: 'Informar recebedor',
      data: { max_date: '2026-08-12' }
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
  assert.equal(
    requests[2].body.interactive.action.parameters.flow_action_payload.data.max_date,
    '2026-08-12'
  );
});

test('converte horário do WhatsApp para São Paulo', () => {
  process.env.APP_TIMEZONE = 'America/Sao_Paulo';
  assert.equal(formatTimestamp(Date.parse('2026-07-14T16:31:11Z') / 1000), '2026-07-14 13:31:11');
});

test('usa o horário informado no Flow ou o horário normal da foto', () => {
  process.env.APP_TIMEZONE = 'America/Sao_Paulo';
  const timestamp = Date.parse('2026-08-12T18:00:00Z') / 1000;
  assert.equal(timestampForPending({
    timestamp,
    deliveryTimestamp: '2026-08-11 09:42:00'
  }), '2026-08-11 09:42:00');
  assert.equal(timestampForPending({ timestamp }), '2026-08-12 15:00:00');
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

test('informa instabilidade quando a Brudam está indisponível', () => {
  const error = Object.assign(new Error('Falha no login Brudam'), {
    code: 'BRUDAM_UNAVAILABLE'
  });
  assert.equal(
    processingFailureMessage(error, 'Mensagem genérica'),
    'O sistema da Brudam está com uma instabilidade momentânea. A baixa não foi confirmada; tente novamente em alguns minutos.'
  );
  assert.equal(
    processingFailureMessage(new Error('Falha na foto'), 'Mensagem genérica'),
    'Mensagem genérica'
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

test('ignora código 1 emitido pelo usuário INTEGRACAO CIA', () => {
  const ciaEvent = {
    status: 1,
    usuario: 'INTEGRACAO CIA',
    descricao: 'ENTREGA REALIZADA NORMALMENTE'
  };
  assert.equal(isCiaIntegrationDelivery(ciaEvent), true);
  assert.equal(hasDeliveryOccurrence({
    status: 1,
    data: [{ status: 1, dados: [ciaEvent] }]
  }), false);
});

test('aceita código 1 posterior emitido por outro operador', () => {
  assert.equal(hasDeliveryOccurrence({
    status: 1,
    data: [{
      status: 1,
      dados: [
        {
          status: 1,
          usuario: 'INTEGRACAO CIA',
          descricao: 'ENTREGA REALIZADA NORMALMENTE'
        },
        {
          status: 1,
          usuario: 'ALAN',
          descricao: 'ENTREGA REALIZADA NORMALMENTE'
        }
      ]
    }]
  }), true);
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

test('amplia e normaliza uma foto antes da segunda tentativa', async () => {
  const input = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: '#d0d0d0'
    }
  }).jpeg().toBuffer();
  const output = await enhanceForBarcode(input);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 80);
  assert.equal(metadata.height, 40);
});
