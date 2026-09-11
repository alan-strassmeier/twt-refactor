const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  namesFromEmail,
  categoriesFromValue,
  categoriesFromLdif
} = require('../server/faturamento/cobranca-contact-import');
const seed = require('../server/faturamento/cobranca-contacts-seed.json');
const {
  normalizedContact,
  deliveryField,
  saoPauloDate: logDate
} = require('../server/faturamento/cobranca-store');
const {
  EVENT_TYPES,
  billingSubject,
  billingText,
  billingAttachments,
  sendBillingEmail
} = require('../server/faturamento/cobranca-email');
const {
  addDays,
  scanInvoices,
  processInvoiceEvent
} = require('../server/faturamento/cobranca-processor');
const {
  constantTimeEqual,
  hasCronAuthorization
} = require('../api/faturamento/cobranca');

const invoiceData = (payment = null) => ({
  invoice: {
    id: '11756',
    dueAt: '2026-11-06',
    total: 2193.61,
    payment
  },
  client: {
    tradeName: 'CLIENTE TESTE',
    name: 'CLIENTE TESTE LTDA',
    document: '11280282000144'
  }
});

test('infere nome e sobrenome do local-part do e-mail', () => {
  assert.deepEqual(namesFromEmail('jon.doe@email.com'), { firstName: 'Jon', lastName: 'Doe' });
  assert.deepEqual(namesFromEmail('jon-doe@email.com'), { firstName: 'Jon', lastName: 'Doe' });
  assert.deepEqual(namesFromEmail('jon_doe@email.com'), { firstName: 'Jon', lastName: 'Doe' });
  assert.deepEqual(namesFromEmail('financeiro@email.com'), { firstName: 'Financeiro', lastName: '' });
  assert.deepEqual(
    normalizedContact('11280282000144', { email: 'maria-silva@example.com' }),
    {
      id: normalizedContact('11280282000144', { email: 'maria-silva@example.com' }).id,
      firstName: 'Maria',
      lastName: 'Silva',
      email: 'maria-silva@example.com'
    }
  );
});

test('expande categorias múltiplas e ignora contato sem categoria', () => {
  assert.deepEqual(categoriesFromValue(
    '41870054000276 - Jimi Itajai,41870054000195 - Jimi Iot SP'
  ), [
    { cnpj: '41870054000276', name: 'Jimi Itajai' },
    { cnpj: '41870054000195', name: 'Jimi Iot SP' }
  ]);
  const categories = categoriesFromLdif([
    'dn: cn=Jon Doe,mail=jon.doe@example.com',
    'givenname: Jon',
    'sn: Doe',
    'categories: 11280282000144 - BHZ Target',
    'mail: jon.doe@example.com',
    '',
    'dn: cn=Sem Categoria,mail=ignorar@example.com',
    'mail: ignorar@example.com'
  ].join('\n'));
  assert.equal(categories.length, 1);
  assert.equal(categories[0].contacts.length, 1);
  assert.equal(categories[0].contacts[0].email, 'jon.doe@example.com');
});

test('semente contém apenas associações categorizadas importadas do Zoho', () => {
  assert.equal(seed.length, 39);
  assert.equal(seed.reduce((total, category) => total + category.contacts.length, 0), 115);
  assert.ok(seed.every((category) => /^\d{14}$/.test(category.cnpj)));
  assert.ok(seed.every((category) => category.contacts.length > 0));
});

test('monta assuntos e textos dos três tipos de cobrança', () => {
  const contact = { firstName: 'Maria', lastName: 'Silva', email: 'maria@example.com' };
  assert.equal(
    billingSubject(EVENT_TYPES.initial, invoiceData()),
    'Fatura : 11756 Vecto: 06/11/2026 - TWT LOG'
  );
  assert.match(billingText(EVENT_TYPES.reminder, invoiceData(), contact), /Perto do vencimento/);
  assert.match(billingText(EVENT_TYPES.overdue, invoiceData(), contact), /encontra-se vencida/);
  assert.equal(
    billingSubject(EVENT_TYPES.overdue, invoiceData()),
    'Aviso de Fatura Vencida - TWT LOG'
  );
});

test('anexa boleto somente quando o PDF bancário existe', () => {
  assert.equal(billingAttachments({ invoiceId: 1, invoicePdf: Buffer.from('f') }).length, 1);
  assert.equal(billingAttachments({
    invoiceId: 1,
    invoicePdf: Buffer.from('f'),
    bankSlipPdf: Buffer.from('b')
  }).length, 2);
});

test('copia Adriano nos avisos próximos e vencidos', async () => {
  const calls = [];
  const transport = { sendMail: async (message) => {
    calls.push(message);
    return { messageId: 'm-1', accepted: ['maria@example.com'], rejected: [], response: '250 OK' };
  } };
  const input = {
    data: invoiceData(),
    contact: { firstName: 'Maria', lastName: '', email: 'maria@example.com' },
    invoicePdf: Buffer.from('pdf'),
    transport,
    config: {
      fromName: 'TWT LOG',
      fromEmail: 'faturamento@twt.com.br',
      alertCopy: 'adriano@twt.com.br'
    }
  };
  await sendBillingEmail({ ...input, event: EVENT_TYPES.initial });
  await sendBillingEmail({ ...input, event: EVENT_TYPES.reminder });
  await sendBillingEmail({ ...input, event: EVENT_TYPES.overdue });
  assert.equal(calls[0].cc, undefined);
  assert.equal(calls[1].cc, 'adriano@twt.com.br');
  assert.equal(calls[2].cc, 'adriano@twt.com.br');
});

test('varre páginas e calcula o dia de lembrete sem depender do fuso do servidor', async () => {
  const calls = [];
  const result = await scanInvoices({ status: '0' }, {
    maxPages: 2,
    fetch: async (input) => {
      calls.push(input.skip);
      return {
        invoices: [{ id: input.skip + 1, status: 0 }],
        pagination: { hasMore: input.skip === 0 }
      };
    }
  });
  assert.deepEqual(calls, [0, 100]);
  assert.deepEqual(result.invoices.map((invoice) => invoice.id), [1, 101]);
  assert.equal(addDays('2026-09-10', 2), '2026-09-12');
});

const processorContext = (overrides = {}) => {
  const summary = {
    pendingDoccob: 0,
    waitingContacts: 0,
    alreadySent: 0,
    sent: 0,
    review: 0
  };
  return {
    now: () => new Date('2026-09-10T12:00:00Z'),
    summary,
    pendingByInvoice: new Map(),
    emailConfig: { fromName: 'TWT', fromEmail: 'faturamento@twt.com.br', alertCopy: 'adriano@twt.com.br' },
    transport: {},
    findDoccobForInvoice: async () => ({}),
    fetchInvoicePdfData: async () => invoiceData({ type: 'ted_doc' }),
    buildInvoicePdf: async () => Buffer.from('fatura'),
    generateInvoiceBankSlip: async () => ({ status: 'ready' }),
    getInvoiceBankSlipPdf: async () => Buffer.from('boleto'),
    sendBillingEmail: async () => ({ messageId: 'm-1', accepted: [], rejected: [] }),
    getCategory: async () => ({ contacts: [{ id: '1', firstName: 'Maria', lastName: '', email: 'maria@example.com' }] }),
    savePending: async () => {},
    removePending: async () => {},
    getDelivery: async () => null,
    claimDelivery: async () => true,
    saveDelivery: async () => {},
    addLog: async () => {},
    ...overrides
  };
};

test('mantém a fatura na fila enquanto o DOCCOB não chegou', async () => {
  const saved = [];
  const context = processorContext({
    findDoccobForInvoice: async () => null,
    savePending: async (record) => saved.push(record)
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.initial,
    invoice: { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    context
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].reason, 'doccob');
  assert.equal(context.summary.pendingDoccob, 1);
});

test('fatura TED envia somente a fatura e não tenta gerar boleto', async () => {
  let boletoCalls = 0;
  let sentInput;
  const context = processorContext({
    generateInvoiceBankSlip: async () => { boletoCalls += 1; },
    sendBillingEmail: async (input) => {
      sentInput = input;
      return { messageId: 'm-1', accepted: ['maria@example.com'], rejected: [] };
    }
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.initial,
    invoice: { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    context
  });
  assert.equal(boletoCalls, 0);
  assert.equal(sentInput.bankSlipPdf, null);
  assert.equal(context.summary.sent, 1);
});

test('mantém na fila a fatura que ainda não possui destinatário', async () => {
  const saved = [];
  const context = processorContext({
    getCategory: async () => null,
    savePending: async (record) => saved.push(record)
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.initial,
    invoice: { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    context
  });
  assert.equal(saved.at(-1).reason, 'contacts');
  assert.equal(context.summary.waitingContacts, 1);
});

test('chave de idempotência separa evento, fatura e destinatário', () => {
  assert.equal(
    deliveryField('reminder', '11756', 'Maria@Example.com'),
    'reminder:11756:maria@example.com'
  );
  assert.equal(logDate('2026-09-11T01:30:00.000Z'), '2026-09-10');
});

test('endpoint do cron exige segredo longo e compara em tempo constante', () => {
  const secret = 'x'.repeat(40);
  assert.equal(constantTimeEqual(`Bearer ${secret}`, `Bearer ${secret}`), true);
  assert.equal(constantTimeEqual('Bearer errado', `Bearer ${secret}`), false);
  assert.equal(hasCronAuthorization({ headers: { authorization: `Bearer ${secret}` } }, {
    BILLING_CRON_SECRET: secret
  }), true);
  assert.equal(hasCronAuthorization({ headers: { authorization: 'Bearer curto' } }, {
    BILLING_CRON_SECRET: 'curto'
  }), false);
});

test('interface expõe cadastro, pendências e logs sem criar várias funções serverless', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'faturamento', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'faturamento', 'cobranca.js'), 'utf8');
  assert.match(html, /data-billing-area="collection"/);
  assert.match(html, /id="categoryForm"/);
  assert.match(html, /id="pendingRows"/);
  assert.match(html, /id="collectionLogsForm"/);
  assert.match(html, /href="#pendingDoccobSection"/);
  assert.match(html, /href="#collectionLogsSection"/);
  assert.match(source, /route, \.\.\.query/);
  assert.equal(fs.existsSync(path.join(root, 'api', 'faturamento', 'cobranca.js')), true);
});
