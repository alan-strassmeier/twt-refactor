const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSubmission,
  emailContent,
  smtpConfig,
  sendSubmission,
  allowSubmission,
  localRateLimit
} = require('../server/public-forms');
const { createHandler } = require('../api/public-form');

const contact = () => ({
  kind: 'contact',
  fields: {
    Nome: 'Ana Silva',
    Email: 'ana@example.com',
    Cidade: 'Porto Alegre',
    Estado: 'Rio Grande do Sul',
    subject: 'Dúvida sobre entrega',
    Mensagem: 'Preciso de informações.'
  }
});

const quotation = () => ({
  kind: 'quotation',
  fields: {
    Nome: 'Ana Silva', Email: 'ana@example.com', Telefone: '(51) 99999-9999',
    Empresa: 'Cliente Ltda', Origem: 'Porto Alegre', Destino: 'São Paulo',
    Quantidade: '2', Peso: '10', Largura: '20', Altura: '30', Comprimento: '40',
    ValorNf: '100,00', remetente: '529.982.247-25', destinatario: '529.982.247-25',
    Descricao: 'Dois volumes'
  }
});

const response = () => ({
  statusCode: 200,
  headers: {},
  setHeader(name, value) { this.headers[name] = value; },
  end(body) { this.body = JSON.parse(body); }
});

const request = (body, overrides = {}) => ({
  method: 'POST',
  headers: {
    host: 'www.twt.com.br', origin: 'https://www.twt.com.br',
    'content-type': 'application/json', 'x-forwarded-for': '192.0.2.25'
  },
  body,
  ...overrides
});

test('valida contato e cotação e não aceita destinatário fornecido pelo visitante', () => {
  const sent = validateSubmission({ ...contact(), fields: { ...contact().fields, recipient: 'outro@example.com' } });
  assert.equal(sent.fields.recipient, undefined);
  assert.equal(emailContent(sent).to, 'twt@twt.com.br');
  assert.equal(emailContent(sent).replyTo, 'ana@example.com');
  assert.match(emailContent(sent).text, /Mensagem: Preciso de informações/);
  assert.equal(emailContent(validateSubmission(quotation())).subject, 'Nova cotação pelo site');
});

test('rejeita dados inválidos antes de enviar', () => {
  assert.throws(() => validateSubmission({ ...contact(), fields: { ...contact().fields, Email: 'invalido' } }), /e-mail válido/);
  assert.throws(() => validateSubmission({ ...contact(), fields: { ...contact().fields, subject: 'Assunto\nBcc: outro@example.com' } }), /Valor inválido/);
  assert.throws(() => validateSubmission({ ...quotation(), fields: { ...quotation().fields, remetente: '000.000.000-00' } }), /CPF\/CNPJ válido/);
});

test('reutiliza as credenciais SMTP do faturamento e envia como twt@twt.com.br', async () => {
  const env = { ZOHO_SMTP_USER: 'conta@twt.com.br', ZOHO_SMTP_PASSWORD: 'senha-de-teste' };
  assert.equal(smtpConfig(env).auth.user, 'conta@twt.com.br');
  assert.throws(() => smtpConfig({}), /não configurado/);
  let options;
  let message;
  await sendSubmission(validateSubmission(contact()), env, (config) => {
    options = config;
    return { sendMail: async (mail) => { message = mail; } };
  });
  assert.equal(options.auth.user, 'conta@twt.com.br');
  assert.equal(message.from.address, 'twt@twt.com.br');
  assert.equal(message.to, 'twt@twt.com.br');
});

test('endpoint recusa origem diferente e envia apenas formulário validado', async () => {
  let sent;
  const handler = createHandler({
    allow: async () => true,
    send: async (submission) => { sent = submission; }
  });
  const forbidden = response();
  await handler(request(contact(), { headers: { ...request().headers, origin: 'https://outro.example' } }), forbidden);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(sent, undefined);

  const ok = response();
  await handler(request(contact()), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(sent.fields.Email, 'ana@example.com');
});

test('campo-armadilha e excesso de tentativas não geram e-mail', async () => {
  let sent = 0;
  const handler = createHandler({
    allow: async () => false,
    send: async () => { sent += 1; }
  });
  const trapped = response();
  await handler(request({ ...contact(), website: 'spam' }), trapped);
  assert.equal(trapped.statusCode, 200);
  const limited = response();
  await handler(request(contact()), limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(sent, 0);
});

test('endpoint trata método, JSON inválido e falha SMTP sem expor detalhes', async () => {
  const handler = createHandler({
    allow: async () => true,
    send: async () => { throw new Error('credencial SMTP secreta'); }
  });
  const method = response();
  await handler(request(contact(), { method: 'GET' }), method);
  assert.equal(method.statusCode, 405);

  const malformed = response();
  await handler(request('{invalido'), malformed);
  assert.equal(malformed.statusCode, 400);

  const failed = response();
  const originalError = console.error;
  console.error = () => {};
  try {
    await handler(request(contact()), failed);
  } finally {
    console.error = originalError;
  }
  assert.equal(failed.statusCode, 500);
  assert.doesNotMatch(failed.body.message, /credencial SMTP secreta/);
});

test('limite local e Redis retornam bloqueio na sexta tentativa', async () => {
  const key = `teste-${Date.now()}`;
  for (let index = 0; index < 5; index += 1) assert.equal(localRateLimit(key), true);
  assert.equal(localRateLimit(key), false);
  const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example.com', UPSTASH_REDIS_REST_TOKEN: 'teste' };
  const allowed = await allowSubmission('192.0.2.1', env, async (_url, options) => {
    assert.match(options.headers.Authorization, /^Bearer teste$/);
    return { ok: true, json: async () => [{ result: 6 }, { result: 1 }] };
  });
  assert.equal(allowed, false);
});
