'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { simpleParser } = require('mailparser');
const { processCollectionEmail } = require('../services/coletas-email/processor');
const { externalDomains } = require('../services/coletas-email/routing');
const { pdfAttachments } = require('../services/coletas-email/email-data');

const eml = ({ to, pdf = true }) => Buffer.from([
  'From: TWT Airpack <twt@twt.com.br>',
  `To: ${to}`,
  'Subject: Coleta 7776 agendada',
  'Message-ID: <coleta-7776@teste.local>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="coleta"',
  '',
  '--coleta',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Dados da coleta',
  ...(pdf ? [
    '--coleta',
    'Content-Type: text/plain; name="twt_coleta_7776.pdf"',
    'Content-Disposition: attachment; filename="twt_coleta_7776.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.3\nPDF DE TESTE').toString('base64')
  ] : []),
  '--coleta--',
  ''
].join('\r\n'));

class MemoryState {
  constructor() {
    this.delivered = new Map();
    this.alerted = new Set();
    this.attempts = new Map();
  }
  wasDelivered(key) { return this.delivered.has(key); }
  async markDelivered(key, value) { this.delivered.set(key, value); }
  wasAlerted(key) { return this.alerted.has(key); }
  async markAlerted(key) { this.alerted.add(key); }
  async registerFailure(key) {
    const count = (this.attempts.get(key) || 0) + 1;
    this.attempts.set(key, count);
    return count;
  }
}

const dependencies = (overrides = {}) => {
  const sends = [];
  const alerts = [];
  const uploads = [];
  return {
    sends,
    alerts,
    uploads,
    value: {
      allowedSenders: ['twt@twt.com.br'],
      internalDomains: ['twt.com.br'],
      maxPdfBytes: 10 * 1024 * 1024,
      maxAttempts: 3,
      registry: { domains: {
        'gvrtransportes.com': {
          company: 'GVR',
          contacts: [{ name: 'GVR Operacional', phone: '5541999999999' }]
        },
        'segunda.com.br': {
          company: 'Segunda',
          contacts: [{ name: 'Segunda Operacional', phone: '5511999999999' }]
        }
      } },
      state: new MemoryState(),
      whatsapp: {
        uploadPdf: async (pdf) => { uploads.push(pdf); return 'media-1'; },
        sendPdf: async (...args) => { sends.push(args); return `wamid-${sends.length}`; }
      },
      mailer: { send: async (payload) => { alerts.push(payload); } },
      ...overrides
    }
  };
};

test('reconhece o PDF verdadeiro mesmo quando o e-mail declara text/plain', async () => {
  const message = await simpleParser(eml({ to: 'SAC <sac@gvrtransportes.com>' }));
  const pdfs = pdfAttachments(message, 1024 * 1024);
  assert.equal(pdfs.length, 1);
  assert.equal(pdfs[0].filename, 'twt_coleta_7776.pdf');
});

test('extrai todos os domínios externos e ignora o domínio interno', async () => {
  const message = await simpleParser(eml({
    to: 'sac@gvrtransportes.com, coleta@segunda.com.br, twt@twt.com.br'
  }));
  assert.deepEqual(externalDomains(message, ['twt.com.br']), [
    'gvrtransportes.com',
    'segunda.com.br'
  ]);
});

test('envia somente o mesmo PDF para os contatos de dois domínios cadastrados', async () => {
  const message = await simpleParser(eml({
    to: 'sac@gvrtransportes.com, coleta@segunda.com.br, twt@twt.com.br'
  }));
  const deps = dependencies();
  const result = await processCollectionEmail(message, deps.value);

  assert.equal(result.sent, 2);
  assert.equal(deps.uploads.length, 1);
  assert.deepEqual(deps.sends.map(([phone, mediaId, filename]) => ({ phone, mediaId, filename })), [
    { phone: '5541999999999', mediaId: 'media-1', filename: 'twt_coleta_7776.pdf' },
    { phone: '5511999999999', mediaId: 'media-1', filename: 'twt_coleta_7776.pdf' }
  ]);
  assert.equal(deps.alerts.length, 0);
});

test('envia aos domínios conhecidos e avisa por e-mail sobre o domínio não cadastrado', async () => {
  const message = await simpleParser(eml({
    to: 'sac@gvrtransportes.com, coleta@nao-cadastrado.com, twt@twt.com.br'
  }));
  const deps = dependencies();
  const result = await processCollectionEmail(message, deps.value);

  assert.equal(result.sent, 1);
  assert.deepEqual(result.missingDomains, ['nao-cadastrado.com']);
  assert.equal(deps.sends.length, 1);
  assert.equal(deps.alerts.length, 1);
  assert.match(deps.alerts[0].issue, /sem contato cadastrado/i);
  assert.match(deps.alerts[0].details[0], /nao-cadastrado\.com/);
});

test('não reenvia o PDF quando o mesmo e-mail for processado novamente', async () => {
  const message = await simpleParser(eml({ to: 'sac@gvrtransportes.com' }));
  const deps = dependencies();
  await processCollectionEmail(message, deps.value);
  await processCollectionEmail(message, deps.value);

  assert.equal(deps.uploads.length, 1);
  assert.equal(deps.sends.length, 1);
});

test('avisa por e-mail quando a coleta não possui PDF válido', async () => {
  const message = await simpleParser(eml({ to: 'sac@gvrtransportes.com', pdf: false }));
  const deps = dependencies();
  const result = await processCollectionEmail(message, deps.value);
  assert.equal(result.terminalError, true);
  assert.equal(deps.alerts.length, 1);
  assert.match(deps.alerts[0].issue, /PDF.*ausente/i);
});
