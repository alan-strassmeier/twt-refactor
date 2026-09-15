const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const {
  namesFromEmail,
  categoriesFromValue,
  categoriesFromLdif
} = require('../server/faturamento/cobranca-contact-import');
const seed = require('../server/faturamento/cobranca-contacts-seed.json');
const {
  normalizedContact,
  mergeContacts,
  setContactEnabled,
  deliveryField,
  saoPauloDate: logDate,
  listLogs,
  claimProcessingRun,
  releaseProcessingRun
} = require('../server/faturamento/cobranca-store');
const {
  companyFromPayload,
  contactsFromCompany,
  registerCompany,
  removeCompanyContact,
  deleteContact: deleteBrudamContact
} = require('../server/faturamento/cobranca-brudam-contacts');
const {
  EVENT_TYPES,
  billingSubject,
  billingText,
  billingAttachments,
  billingEmailPreview,
  sendBillingEmail
} = require('../server/faturamento/cobranca-email');
const {
  deliveryReference,
  webhookTokenAuthorized,
  validateWebhook,
  extractWebhookEvents,
  processWebhookPayload
} = require('../server/faturamento/cobranca-webhook');
const {
  addDays,
  billingEventForInvoice,
  buildBillingQueue,
  scanInvoices,
  pendingRecord,
  isTerminalBillingFailure,
  processInvoiceEvent,
  resendBillingInvoice
} = require('../server/faturamento/cobranca-processor');
const {
  constantTimeEqual,
  hasCronAuthorization
} = require('../api/faturamento/cobranca');
const {
  invoiceControl,
  buildUnifiedIssues,
  buildInvoiceTimeline,
  billingWhatsappText
} = require('../server/faturamento/invoice-control');
const {
  TWT_BILLING_START_DATE,
  isTwtBillingEligible
} = require('../server/faturamento/billing-rules');

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
      email: 'maria-silva@example.com',
      enabled: true
    }
  );
});

test('interpreta os contatos de xGrupo retornados pela Brudam', () => {
  const payload = {
    status: 1,
    data: [{
      cnpj: '11.280.282/0001-44',
      fantasia: 'BHZ',
      xGrupo: [
        { xNome: 'MARIA SILVA', email: 'Maria@Example.com', telefone: '51999999999' },
        { xNome: 'Sem e-mail', email: '' }
      ]
    }]
  };
  const company = companyFromPayload(payload, '11280282000144');
  assert.equal(company.fantasia, 'BHZ');
  assert.deepEqual(contactsFromCompany(company), [{
    firstName: 'MARIA SILVA',
    lastName: '',
    email: 'maria@example.com',
    enabled: false
  }]);
});

test('ao cadastrar empresa importa os contatos da Brudam pelo CNPJ', async () => {
  const saved = [];
  const merged = [];
  const storage = {
    saveCategory: async (category) => {
      saved.push(category);
      return { ...category, cnpj: '11280282000144', contacts: [] };
    },
    mergeContacts: async (cnpj, contacts) => {
      merged.push({ cnpj, contacts });
      return {
        category: { cnpj, name: 'BHZ', contacts },
        added: contacts
      };
    }
  };
  const result = await registerCompany({ cnpj: '11.280.282/0001-44', name: '' }, {
    store: storage,
    get: async (url) => {
      assert.equal(url, '/cadastro/empresas?cnpj=11280282000144');
      return {
        response: { ok: true, status: 200 },
        payload: {
          status: 1,
          data: [{
            cnpj: '11280282000144',
            fantasia: 'BHZ',
            xGrupo: [{ xNome: 'Maria Silva', email: 'maria@example.com' }]
          }]
        }
      };
    }
  });
  assert.deepEqual(saved, [{ cnpj: '11.280.282/0001-44', name: 'BHZ' }]);
  assert.equal(merged[0].cnpj, '11280282000144');
  assert.equal(result.imported, 1);
});

test('remove da Brudam somente o contato escolhido e confirma por novo GET', async () => {
  const original = {
    status: 1,
    data: [{
      cnpj: '11280282000144',
      fantasia: 'BHZ',
      xGrupo: [
        { xNome: 'Maria', email: 'maria@example.com', telefone: '1111', alertaOcorrencias: 'S' },
        { xNome: 'João', email: 'joao@example.com', telefone: '2222', preAlertaWhatsApp: 'N' }
      ]
    }]
  };
  const verified = {
    status: 1,
    data: [{
      cnpj: '11280282000144',
      fantasia: 'BHZ',
      xGrupo: [{ xNome: 'João', email: 'joao@example.com', telefone: '2222', preAlertaWhatsApp: 'N' }]
    }]
  };
  let getCalls = 0;
  let patchBody;
  const result = await removeCompanyContact('11280282000144', 'maria@example.com', {
    get: async () => ({ response: { ok: true, status: 200 }, payload: getCalls++ ? verified : original }),
    patch: async (url, body) => {
      assert.equal(url, '/cadastro/empresas');
      patchBody = body;
      return { response: { ok: true, status: 200 }, payload: { status: 1, message: 'OK' } };
    }
  });
  assert.equal(result.removed, true);
  assert.deepEqual(patchBody, {
    nCNPJ: '11280282000144',
    xGrupo: [{
      xNome: 'João',
      email: 'joao@example.com',
      telefone: '2222',
      preAlertaWhatsApp: 'N'
    }]
  });
  assert.equal(getCalls, 2);
});

test('preserva o contato local quando a Brudam não confirma a exclusão', async () => {
  const category = {
    cnpj: '11280282000144',
    name: 'BHZ',
    contacts: [{ id: 'contato-1', email: 'maria@example.com' }]
  };
  let localDeletes = 0;
  const remotePayload = {
    status: 1,
    data: [{ cnpj: category.cnpj, fantasia: category.name, xGrupo: [{ xNome: 'Maria', email: 'maria@example.com' }] }]
  };
  await assert.rejects(deleteBrudamContact(category.cnpj, 'contato-1', {
    store: {
      getCategory: async () => category,
      deleteContact: async () => { localDeletes += 1; return true; }
    },
    get: async () => ({ response: { ok: true, status: 200 }, payload: remotePayload }),
    patch: async () => ({ response: { ok: true, status: 200 }, payload: { status: 1 } })
  }), /não confirmou/);
  assert.equal(localDeletes, 0);
});

test('Redis preserva contatos existentes e altera somente a opção de envio', async () => {
  let value = JSON.stringify({
    cnpj: '11280282000144',
    name: 'BHZ',
    contacts: [{
      id: 'contato-1',
      firstName: 'Maria',
      lastName: '',
      email: 'maria@example.com'
    }]
  });
  const command = async (name, ...args) => {
    if (name === 'EVAL') return 0;
    if (name === 'HGET') return value;
    if (name === 'HSET') {
      value = args[2];
      return 1;
    }
    throw new Error(`Comando inesperado: ${name}`);
  };
  const merged = await mergeContacts('11280282000144', [
    { firstName: 'Maria duplicada', email: 'MARIA@example.com' },
    { firstName: 'João', email: 'joao@example.com' }
  ], command);
  assert.equal(merged.added.length, 1);
  assert.equal(merged.category.contacts.length, 2);

  const toggled = await setContactEnabled('11280282000144', 'contato-1', false, command);
  assert.equal(toggled.contact.enabled, false);
  assert.equal(JSON.parse(value).contacts.find((contact) => contact.id === 'contato-1').enabled, false);
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

test('anexa DACTEs em um único PDF quando o documento é informado', () => {
  const attachments = billingAttachments({
    invoiceId: 11532,
    invoicePdf: Buffer.from('fatura'),
    dactePdf: Buffer.from('dactes'),
    bankSlipPdf: Buffer.from('boleto')
  });
  assert.deepEqual(attachments.map((attachment) => attachment.filename), [
    'fatura-11532.pdf',
    'dactes-fatura-11532.pdf',
    'boleto-fatura-11532.pdf'
  ]);
});

test('anexa a nota fiscal no lugar do DACTE para a cobrança da TWT', () => {
  const attachments = billingAttachments({
    invoiceId: 11780,
    invoicePdf: Buffer.from('fatura'),
    nfsePdf: Buffer.from('danfse'),
    bankSlipPdf: Buffer.from('boleto')
  });
  assert.deepEqual(attachments.map((attachment) => attachment.filename), [
    'fatura-11780.pdf',
    'nota-fiscal-fatura-11780.pdf',
    'boleto-fatura-11780.pdf'
  ]);
});

test('salva uma prévia textual do e-mail sem duplicar os PDFs', () => {
  const preview = billingEmailPreview({
    event: EVENT_TYPES.reminder,
    data: invoiceData(),
    contact: { firstName: 'Maria', lastName: 'Silva', email: 'maria@example.com' },
    dactePdf: Buffer.from('dactes'),
    bankSlipPdf: Buffer.from('boleto'),
    config: { fromName: 'TWT LOG', fromEmail: 'faturamento@twt.com.br' }
  });
  assert.equal(preview.fromEmail, 'faturamento@twt.com.br');
  assert.equal(preview.toName, 'Maria Silva');
  assert.equal(preview.priority, 'high');
  assert.match(preview.subject, /Fatura : 11756/);
  assert.match(preview.text, /Perto do vencimento/);
  assert.deepEqual(preview.attachments, [
    'fatura-11756.pdf',
    'dactes-fatura-11756.pdf',
    'boleto-fatura-11756.pdf'
  ]);
  assert.equal(Object.values(preview).some(Buffer.isBuffer), false);
});

test('não inclui Adriano em cópia nas mensagens dos clientes', async () => {
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
      alertEmail: 'adriano@twt.com.br'
    }
  };
  await sendBillingEmail({ ...input, event: EVENT_TYPES.initial });
  await sendBillingEmail({ ...input, event: EVENT_TYPES.reminder });
  await sendBillingEmail({ ...input, event: EVENT_TYPES.overdue });
  assert.equal(calls[0].cc, undefined);
  assert.equal(calls[1].cc, undefined);
  assert.equal(calls[2].cc, undefined);
  assert.equal(calls[0].priority, undefined);
  assert.equal(calls[1].priority, 'high');
  assert.equal(calls[2].priority, 'high');
});

test('envia ao ZeptoMail uma referência determinística sem expor o e-mail', async () => {
  const calls = [];
  const reference = deliveryReference(EVENT_TYPES.initial, '11756', 'Maria@Example.com');
  await sendBillingEmail({
    event: EVENT_TYPES.initial,
    data: invoiceData(),
    contact: { firstName: 'Maria', lastName: '', email: 'maria@example.com' },
    invoicePdf: Buffer.from('pdf'),
    clientReference: reference,
    transport: { sendMail: async (message) => {
      calls.push(message);
      return { messageId: 'm-1', accepted: ['maria@example.com'], rejected: [] };
    } },
    config: { fromName: 'TWT', fromEmail: 'faturamento@twt.com.br' }
  });
  assert.equal(calls[0].headers['X-TM-CLIENT-REF'], reference);
  assert.match(reference, /^twt-initial-11756-[a-f0-9]{16}$/);
  assert.doesNotMatch(reference, /maria|example/i);
  assert.notEqual(
    deliveryReference(EVENT_TYPES.initial, '11756', 'maria@example.com', 'reenvio-1'),
    deliveryReference(EVENT_TYPES.initial, '11756', 'maria@example.com', 'reenvio-2')
  );
});

test('monta mensagem de WhatsApp adequada para uma fatura vencida', () => {
  const message = billingWhatsappText({
    id: '11756',
    dueAt: '2026-09-10',
    balance: 2193.61,
    client: 'CLIENTE TESTE'
  }, new Date('2026-09-13T12:00:00Z'));
  assert.match(message, /fatura 11756/);
  assert.match(message, /10\/09\/2026/);
  assert.match(message, /R\$\s*2\.193,61/);
  assert.match(message, /previsão de pagamento/);
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

test('classifica pendências pela proximidade do vencimento', () => {
  const today = '2026-09-11';
  assert.equal(
    billingEventForInvoice({ issuedAt: today, dueAt: '2026-10-01' }, today),
    EVENT_TYPES.initial
  );
  assert.equal(
    billingEventForInvoice({ issuedAt: '2026-09-01', dueAt: '2026-09-13' }, today),
    EVENT_TYPES.reminder
  );
  assert.equal(
    billingEventForInvoice({ issuedAt: '2026-09-01', dueAt: '2026-09-12' }, today),
    EVENT_TYPES.reminder
  );
  assert.equal(
    billingEventForInvoice({ issuedAt: '2025-05-07', dueAt: '2025-07-07' }, today),
    EVENT_TYPES.overdue
  );
});

test('mantém somente o evento mais urgente para cada fatura', () => {
  const queue = buildBillingQueue({
    currentDate: '2026-09-11',
    pending: [
      { invoiceId: '10630', issuedAt: '2025-05-07', dueAt: '2025-07-07' },
      { invoiceId: '11780', issuedAt: '2026-09-10', dueAt: '2026-09-13' }
    ],
    today: [
      { id: '11781', issuedAt: '2026-09-11', dueAt: '2026-10-01' },
      { id: '11782', issuedAt: '2026-09-11', dueAt: '2026-09-13' }
    ],
    reminder: [
      { id: '11780', issuedAt: '2026-09-10', dueAt: '2026-09-13' },
      { id: '11782', issuedAt: '2026-09-11', dueAt: '2026-09-13' }
    ],
    overdue: [{ id: '10630', issuedAt: '2025-05-07', dueAt: '2025-07-07' }]
  });
  assert.deepEqual(queue.map(({ invoice, event }) => [invoice.id, event]), [
    ['10630', EVENT_TYPES.overdue],
    ['11780', EVENT_TYPES.reminder],
    ['11781', EVENT_TYPES.initial],
    ['11782', EVENT_TYPES.reminder]
  ]);
  assert.equal(queue.find((item) => item.invoice.id === '10630').fromPending, true);
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
    emailConfig: { fromName: 'TWT', fromEmail: 'faturamento@twt.com.br', alertEmail: 'adriano@twt.com.br' },
    transport: {},
    findDoccobForInvoice: async () => ({}),
    fetchInvoicePdfData: async () => invoiceData({ type: 'ted_doc' }),
    buildInvoicePdf: async () => Buffer.from('fatura'),
    resolveInvoiceCteKeys: async () => ({ cteKeys: [] }),
    fetchCteXmls: async () => [],
    parseCteXml: (xml) => xml,
    buildDactePdf: async () => Buffer.from('dactes'),
    issueInvoiceNfse: async () => ({ status: 'issued' }),
    getIssuedNfseXml: async () => ({ xml: '<NFSe />' }),
    buildDanfsePdf: async () => Buffer.from('danfse'),
    generateInvoiceBankSlip: async () => ({ status: 'ready' }),
    getInvoiceBankSlipPdf: async () => Buffer.from('boleto'),
    sendBillingEmail: async () => ({ messageId: 'm-1', accepted: [], rejected: [] }),
    getCategory: async () => ({ contacts: [{ id: '1', firstName: 'Maria', lastName: '', email: 'maria@example.com' }] }),
    savePending: async () => {},
    removePending: async () => {},
    getDelivery: async () => null,
    claimDelivery: async () => true,
    saveDelivery: async () => {},
    saveDeliveryReference: async () => {},
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

test('ignora cobrança da TWT anterior ao corte sem gerar boleto, documento ou log', async () => {
  const calls = [];
  const removed = [];
  const context = processorContext({
    findDoccobForInvoice: async () => ({
      invoice: { issuerCnpj: '09123137000108', issuedAt: '2026-09-15' }
    }),
    fetchInvoicePdfData: async () => { calls.push('pdf-data'); },
    generateInvoiceBankSlip: async () => { calls.push('boleto'); },
    sendBillingEmail: async () => { calls.push('email'); },
    addLog: async () => { calls.push('log'); },
    removePending: async (invoiceId) => removed.push(String(invoiceId))
  });
  context.pendingByInvoice.set('11735', {
    invoiceId: '11735',
    reason: 'processing_error'
  });

  const result = await processInvoiceEvent({
    event: EVENT_TYPES.reminder,
    invoice: {
      id: '11735',
      clientDocument: '10629265000107',
      client: 'JTT LOG',
      issuedAt: '2026-09-15'
    },
    context
  });

  assert.deepEqual(result, { skipped: 'twt_before_start' });
  assert.deepEqual(calls, []);
  assert.deepEqual(removed, ['11735']);
  assert.equal(context.pendingByInvoice.has('11735'), false);
  assert.equal(context.summary.skippedTwt, 1);
});

test('habilita a TWT no corte e envia fatura, boleto Bradesco e nota fiscal', async () => {
  const calls = [];
  const references = [];
  let sentInput;
  const context = processorContext({
    findDoccobForInvoice: async () => ({
      invoice: { issuerCnpj: '09123137000108', issuedAt: TWT_BILLING_START_DATE },
      transports: []
    }),
    fetchInvoicePdfData: async () => ({
      ...invoiceData(),
      invoice: {
        ...invoiceData().invoice,
        id: '11780',
        issuedAt: TWT_BILLING_START_DATE
      },
      issuer: { document: '09123137000108' }
    }),
    generateInvoiceBankSlip: async () => {
      calls.push('boleto');
      return { status: 'ready' };
    },
    getInvoiceBankSlipPdf: async () => {
      calls.push('boleto-pdf');
      return Buffer.from('boleto-bradesco');
    },
    issueInvoiceNfse: async () => {
      calls.push('nfse');
      return { status: 'issued' };
    },
    getIssuedNfseXml: async () => {
      calls.push('nfse-xml');
      return { xml: '<NFSe />' };
    },
    buildDanfsePdf: async (xml) => {
      assert.equal(xml, '<NFSe />');
      calls.push('danfse');
      return Buffer.from('nota-fiscal');
    },
    saveDeliveryReference: async (_reference, record) => references.push(record),
    sendBillingEmail: async (input) => {
      sentInput = input;
      return { messageId: 'm-twt', accepted: [input.contact.email], rejected: [] };
    }
  });

  await processInvoiceEvent({
    event: EVENT_TYPES.initial,
    invoice: {
      id: '11780',
      clientDocument: '11280282000144',
      client: 'BHZ',
      issuerDocument: '09123137000108',
      issuedAt: TWT_BILLING_START_DATE
    },
    context
  });

  assert.deepEqual(calls, ['boleto', 'boleto-pdf', 'nfse', 'nfse-xml', 'danfse']);
  assert.equal(sentInput.dactePdf, null);
  assert.equal(sentInput.bankSlipPdf.toString(), 'boleto-bradesco');
  assert.equal(sentInput.nfsePdf.toString(), 'nota-fiscal');
  assert.deepEqual(references[0].emailPreview.attachments, [
    'fatura-11780.pdf',
    'nota-fiscal-fatura-11780.pdf',
    'boleto-fatura-11780.pdf'
  ]);
  assert.equal(context.summary.sent, 1);
});

test('considera a data de corte inclusiva somente para a emissora TWT', () => {
  assert.equal(isTwtBillingEligible({
    issuerCnpj: '09123137000108',
    issuedAt: '15/09/2026'
  }), false);
  assert.equal(isTwtBillingEligible({
    issuerCnpj: '09123137000108',
    issuedAt: '16/09/2026'
  }), true);
  assert.equal(isTwtBillingEligible({
    issuerCnpj: '97434690000129',
    issuedAt: '2026-09-16'
  }), false);
});

test('registra se a pendência foi conferida manualmente ou pelo agendador', () => {
  const record = pendingRecord(
    { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    { attempts: 2, firstSeenAt: '2026-09-10T12:00:00.000Z' },
    '2026-09-11T12:00:00.000Z',
    'doccob',
    '',
    { source: 'automatic', runId: 'execucao-1' }
  );
  assert.equal(record.attempts, 3);
  assert.equal(record.lastCheckSource, 'automatic');
  assert.equal(record.lastRunId, 'execucao-1');
});

test('trava execuções concorrentes da cobrança com expiração de segurança', async () => {
  const calls = [];
  const command = async (...args) => {
    calls.push(args);
    return args[0] === 'SET' ? 'OK' : 1;
  };
  assert.equal(await claimProcessingRun('execucao-1', command), true);
  await releaseProcessingRun('execucao-1', command);
  assert.deepEqual(calls[0].slice(-4), ['execucao-1', 'NX', 'EX', '90']);
  assert.equal(calls[1][0], 'EVAL');
  assert.equal(calls[1].at(-1), 'execucao-1');
});

test('fatura TED envia somente a fatura e não tenta gerar boleto', async () => {
  let boletoCalls = 0;
  let sentInput;
  const references = [];
  const logs = [];
  const context = processorContext({
    generateInvoiceBankSlip: async () => { boletoCalls += 1; },
    saveDeliveryReference: async (_reference, record) => references.push(record),
    addLog: async (record) => logs.push(record),
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
  assert.deepEqual(references[0].emailPreview.attachments, ['fatura-11756.pdf']);
  assert.equal(logs[0].emailPreview.subject, 'Fatura : 11756 Vecto: 06/11/2026 - TWT LOG');
  assert.equal(context.summary.sent, 1);
});

test('não consulta novamente na Brudam uma fatura inicial já enviada', async () => {
  let invoiceLookups = 0;
  const removed = [];
  const context = processorContext({
    fetchInvoicePdfData: async () => {
      invoiceLookups += 1;
      throw new Error('A consulta não deveria ser executada.');
    },
    getDelivery: async (event, invoiceId, email) => (
      event === EVENT_TYPES.initial
      && invoiceId === '11779'
      && email === 'maria@example.com'
        ? { state: 'sent', sentAt: '2026-09-11T15:00:00.000Z' }
        : null
    ),
    removePending: async (invoiceId) => removed.push(String(invoiceId))
  });
  context.pendingByInvoice.set('11779', { invoiceId: '11779', reason: 'processing_error' });

  await processInvoiceEvent({
    event: EVENT_TYPES.initial,
    invoice: {
      id: '11779',
      clientDocument: '41870054000276',
      client: 'JIMI BRASIL'
    },
    context
  });

  assert.equal(invoiceLookups, 0);
  assert.deepEqual(removed, ['11779']);
  assert.equal(context.pendingByInvoice.has('11779'), false);
  assert.equal(context.summary.alreadySent, 1);
});

test('envia aviso de vencimento separado para o cliente e para Adriano', async () => {
  const recipients = [];
  const context = processorContext({
    sendBillingEmail: async ({ contact }) => {
      recipients.push(contact.email);
      return { messageId: `m-${recipients.length}`, accepted: [contact.email], rejected: [] };
    }
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.reminder,
    invoice: { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    context
  });
  assert.deepEqual(recipients, ['maria@example.com', 'adriano@twt.com.br']);
  assert.equal(context.summary.sent, 2);
});

test('não repete para Adriano um aviso antigo que já foi enviado em cópia', async () => {
  const recipients = [];
  const context = processorContext({
    getDelivery: async (event, _invoiceId, email) => (
      event === EVENT_TYPES.reminder && email === 'maria@example.com'
        ? { state: 'sent', sentAt: '2026-09-10T12:00:00.000Z' }
        : null
    ),
    sendBillingEmail: async ({ contact }) => {
      recipients.push(contact.email);
      return { messageId: 'inesperado', accepted: [contact.email], rejected: [] };
    }
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.reminder,
    invoice: { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    context
  });
  assert.deepEqual(recipients, []);
  assert.equal(context.summary.alreadySent, 1);
});

test('avisa Adriano mesmo quando ainda não existe destinatário do cliente', async () => {
  const recipients = [];
  const saved = [];
  const context = processorContext({
    getCategory: async () => null,
    savePending: async (record) => saved.push(record),
    sendBillingEmail: async ({ contact }) => {
      recipients.push(contact.email);
      return { messageId: 'm-alerta', accepted: [contact.email], rejected: [] };
    }
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.overdue,
    invoice: { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    context
  });
  assert.deepEqual(recipients, ['adriano@twt.com.br']);
  assert.equal(saved.at(-1).reason, 'contacts');
  assert.equal(context.pendingByInvoice.has('11756'), true);
});

test('fatura DSL envia todos os DACTEs em um único anexo', async () => {
  const cteKey = '43260797434690000129570000000151221704715130';
  let sentInput;
  const context = processorContext({
    findDoccobForInvoice: async () => ({
      invoice: { issuerCnpj: '97434690000129' },
      transports: [{ accessKey: cteKey }]
    }),
    fetchInvoicePdfData: async () => ({
      ...invoiceData({ type: 'ted_doc' }),
      issuer: { document: '97434690000129' }
    }),
    fetchCteXmls: async (keys) => {
      assert.deepEqual(keys, [cteKey]);
      return ['<cteProc />'];
    },
    parseCteXml: (xml) => ({ xml }),
    buildDactePdf: async (models) => {
      assert.equal(models.length, 1);
      return Buffer.from('dactes-dsl');
    },
    sendBillingEmail: async (input) => {
      sentInput = input;
      return { messageId: 'm-1', accepted: ['maria@example.com'], rejected: [] };
    }
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.initial,
    invoice: { id: '11532', clientDocument: '41870054000276', client: 'JIMI BRASIL' },
    context
  });
  assert.equal(sentInput.dactePdf.toString(), 'dactes-dsl');
});

test('fatura DSL não é enviada sem chave CT-e para o DACTE', async () => {
  let sent = false;
  const context = processorContext({
    findDoccobForInvoice: async () => ({
      invoice: { issuerCnpj: '97434690000129' },
      transports: []
    }),
    fetchInvoicePdfData: async () => ({
      ...invoiceData({ type: 'ted_doc' }),
      issuer: { document: '97434690000129' }
    }),
    sendBillingEmail: async () => { sent = true; }
  });
  await assert.rejects(
    processInvoiceEvent({
      event: EVENT_TYPES.initial,
      invoice: { id: '11532', clientDocument: '41870054000276', client: 'JIMI BRASIL' },
      context
    }),
    /não possui chave CT-e/
  );
  assert.equal(sent, false);
});

test('não repete o cliente vencido, mas envia o alerta separado para Adriano', async () => {
  const recipients = [];
  const context = processorContext({
    fetchInvoicePdfData: async () => ({
      ...invoiceData({ type: 'ted_doc' }),
      invoice: {
        ...invoiceData({ type: 'ted_doc' }).invoice,
        dueAt: '2025-07-07'
      }
    }),
    getDelivery: async (event, _invoiceId, email) => event === EVENT_TYPES.initial && email === 'maria@example.com'
      ? { state: 'sent', sentAt: '2026-09-11T16:14:00.000Z' }
      : null,
    sendBillingEmail: async ({ contact }) => {
      recipients.push(contact.email);
      return { messageId: 'm-alerta', accepted: [contact.email], rejected: [] };
    }
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.overdue,
    invoice: {
      id: '10630',
      clientDocument: '35820448001884',
      client: 'BSB WHITE MARTINS',
      dueAt: '2025-07-07'
    },
    context
  });
  assert.deepEqual(recipients, ['adriano@twt.com.br']);
  assert.equal(context.summary.alreadySent, 1);
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

test('não envia cobrança para contato com envio desabilitado', async () => {
  const saved = [];
  let sent = false;
  const context = processorContext({
    getCategory: async () => ({
      contacts: [{
        id: '1',
        firstName: 'Maria',
        lastName: '',
        email: 'maria@example.com',
        enabled: false
      }]
    }),
    savePending: async (record) => saved.push(record),
    sendBillingEmail: async () => { sent = true; }
  });
  await processInvoiceEvent({
    event: EVENT_TYPES.initial,
    invoice: { id: '11756', clientDocument: '11280282000144', client: 'BHZ' },
    context
  });
  assert.equal(sent, false);
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

test('filtra os logs pela fatura e limita a página a dez registros', async () => {
  const records = Array.from({ length: 17 }, (_, index) => JSON.stringify({
    id: `log-${index}`,
    invoiceId: index < 15 ? '11756' : '99999',
    createdAt: `2026-09-11T12:${String(index).padStart(2, '0')}:00.000Z`
  }));
  const result = await listLogs({ invoiceId: '11756', page: 2 }, async (command) => {
    assert.equal(command, 'ZREVRANGE');
    return records;
  });
  assert.equal(result.total, 15);
  assert.equal(result.logs.length, 5);
  assert.equal(result.pagination.pageSize, 10);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.hasPrevious, true);
  assert.equal(result.pagination.hasNext, false);
  assert.ok(result.logs.every((record) => record.invoiceId === '11756'));
});

test('exibe somente o estado mais recente de cada envio correlacionado', async () => {
  const records = [
    JSON.stringify({ id: 'novo', invoiceId: '11756', clientReference: 'ref-1', status: 'delivered' }),
    JSON.stringify({ id: 'antigo', invoiceId: '11756', clientReference: 'ref-1', status: 'submitted' }),
    JSON.stringify({ id: 'legado', invoiceId: '11756', status: 'submitted' })
  ];
  const result = await listLogs({ invoiceId: '11756' }, async () => records);
  assert.deepEqual(result.logs.map((record) => record.id), ['novo', 'legado']);
  assert.equal(result.total, 2);
});

test('valida a assinatura HMAC do formulário enviado pelo ZeptoMail', () => {
  const payload = {
    event_name: ['delivered'],
    event_message: [{ email_info: { client_reference: 'twt-initial-11756-abc' } }]
  };
  const payloadText = JSON.stringify(payload);
  const authenticationKey = 'chave-de-webhook-com-32-caracteres';
  const timestamp = 1_786_000_000_000;
  const signature = createHmac('sha256', authenticationKey).update(payloadText).digest('base64');
  const parsed = validateWebhook({
    body: `eventData=${encodeURIComponent(payloadText)}`,
    signatureHeader: `ts=${timestamp};s=${encodeURIComponent(signature)};s-algorithm=HmacSHA256`,
    config: { authenticationKey, maxAgeMs: 300_000 },
    now: timestamp + 1_000
  });
  assert.deepEqual(parsed, payload);
  assert.throws(() => validateWebhook({
    body: `eventData=${encodeURIComponent(payloadText)}`,
    signatureHeader: `ts=${timestamp};s=incorreta;s-algorithm=HmacSHA256`,
    config: { authenticationKey, maxAgeMs: 300_000 },
    now: timestamp + 1_000
  }), /Assinatura do webhook inválida/);
});

test('aceita o segredo do webhook em Authorization ou cabeçalho personalizado', () => {
  const authenticationKey = 'chave-de-webhook-com-32-caracteres';
  const config = { authenticationKey, maxAgeMs: 300_000 };
  assert.equal(webhookTokenAuthorized({
    authorization: `Bearer ${authenticationKey}`
  }, config), true);
  assert.equal(webhookTokenAuthorized({
    'x-twt-webhook-token': authenticationKey
  }, config), true);
  assert.equal(webhookTokenAuthorized({
    zoho_webhook_auth_key: authenticationKey
  }, config), true);
  assert.equal(webhookTokenAuthorized({
    authorization: 'Bearer chave-incorreta'
  }, config), false);
});

test('interpreta entrega e bounce com a referência e diagnóstico do ZeptoMail', () => {
  const events = extractWebhookEvents({
    event_name: ['hardbounce'],
    webhook_request_id: 'webhook-1',
    event_message: [{
      request_id: 'request-1',
      email_info: {
        client_reference: 'twt-initial-11756-abc',
        email_reference: 'zepto-1',
        to: { email_address: [{ address: 'maria@example.com' }] }
      },
      event_data: {
        object: 'bounce',
        details: { reason: 'Invalid recipient', diagnostic_message: '550 5.4.1 Access denied' }
      }
    }]
  });
  assert.equal(events[0].status, 'hard_bounce');
  assert.equal(events[0].clientReference, 'twt-initial-11756-abc');
  assert.equal(events[0].email, 'maria@example.com');
  assert.match(events[0].diagnostic, /5\.4\.1/);
});

test('webhook atualiza o envio original e preserva a prévia do e-mail', async () => {
  const saved = [];
  const logs = [];
  const claimed = new Set();
  const reference = deliveryReference('initial', '11756', 'maria@example.com');
  const store = {
    getDeliveryReference: async (value) => value === reference ? {
      event: 'initial',
      invoiceId: '11756',
      clientCnpj: '11280282000144',
      clientName: 'BHZ',
      contactName: 'Maria',
      email: 'maria@example.com',
      emailPreview: { subject: 'Fatura 11756', text: 'Mensagem enviada' }
    } : null,
    claimWebhookEvent: async (id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    releaseWebhookEvent: async (id) => claimed.delete(id),
    getDelivery: async () => ({ state: 'sent', clientReference: reference }),
    saveDelivery: async (...args) => saved.push(args),
    addLog: async (record) => logs.push(record)
  };
  const payload = {
    event_name: ['delivered'],
    webhook_request_id: 'webhook-1',
    event_message: [{
      request_id: 'request-1',
      email_info: { client_reference: reference, email_reference: 'zepto-1' }
    }]
  };
  const now = () => new Date('2026-09-11T18:00:00.000Z');
  const first = await processWebhookPayload(payload, { store, now });
  const second = await processWebhookPayload(payload, { store, now });
  assert.equal(first.processed, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(saved[0][3].state, 'delivered');
  assert.equal(logs[0].status, 'delivered');
  assert.equal(logs[0].invoiceId, '11756');
  assert.equal(logs[0].emailPreview.subject, 'Fatura 11756');
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

test('reenvio manual ignora a trava do envio anterior e cria referência exclusiva', async () => {
  const sent = [];
  const references = [];
  const savedDeliveries = [];
  const invoiceQueries = [];
  const fixedNow = () => new Date('2026-09-13T12:00:00.000Z');
  const result = await resendBillingInvoice('11756', {
    runId: 'reenvio-manual-1',
    clientCnpj: '11280282000144',
    now: fixedNow,
    currentTime: fixedNow(),
    transport: {},
    emailConfig: {
      fromName: 'TWT',
      fromEmail: 'faturamento@twt.com.br',
      alertEmail: ''
    },
    fetchInvoice: async (query) => {
      invoiceQueries.push(query);
      return {
        invoices: query.cnpj ? [{
          id: '11756',
          clientDocument: '11280282000144',
          client: 'CLIENTE TESTE',
          issuedAt: '2026-09-01',
          dueAt: '2026-09-30',
          balance: 100,
          status: 0,
          statusLabel: 'Em aberto'
        }] : []
      };
    },
    listPending: async () => [],
    findDoccobForInvoice: async () => ({}),
    fetchInvoicePdfData: async () => invoiceData({ type: 'ted_doc' }),
    buildInvoicePdf: async () => Buffer.from('fatura'),
    getCategory: async () => ({
      contacts: [{ id: '1', firstName: 'Maria', lastName: '', email: 'maria@example.com' }]
    }),
    getDelivery: async () => ({ state: 'sent' }),
    claimDelivery: async () => false,
    saveDelivery: async (...args) => savedDeliveries.push(args),
    saveDeliveryReference: async (reference, record) => references.push({ reference, record }),
    sendBillingEmail: async (input) => {
      sent.push(input);
      return { messageId: 'm-reenvio', accepted: [input.contact.email], rejected: [] };
    },
    addLog: async () => {},
    removePending: async () => {}
  });
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(invoiceQueries, [
    { id: '11756', limit: 100 },
    { cnpj: '11280282000144', limit: 100 }
  ]);
  assert.match(savedDeliveries[0][0], /^manual_/);
  assert.equal(savedDeliveries[0][3].manualResend, true);
  assert.equal(references[0].record.manualResend, true);
  assert.match(references[0].reference, /^twt-initial-11756-[a-f0-9]{16}$/);
});

test('reenvio manual não inicia envio sem destinatário ativo', async () => {
  await assert.rejects(() => resendBillingInvoice('11756', {
    transport: {},
    emailConfig: {
      fromName: 'TWT',
      fromEmail: 'faturamento@twt.com.br',
      alertEmail: ''
    },
    fetchInvoice: async () => ({
      invoices: [{
        id: '11756',
        clientDocument: '11280282000144',
        balance: 100,
        status: 0,
        statusLabel: 'Em aberto'
      }]
    }),
    getCategory: async () => ({
      contacts: [{ email: 'financeiro@example.com', enabled: false }]
    }),
    listPending: async () => [],
    findDoccobForInvoice: async () => ({}),
    fetchInvoicePdfData: async () => invoiceData({ type: 'ted_doc' }),
    savePending: async () => {},
    removePending: async () => {},
    addLog: async () => {}
  }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /destinatário ativo/i);
    return true;
  });
});

test('reenvio manual bloqueia fatura TWT anterior ao início da automação', async () => {
  let sent = false;
  await assert.rejects(() => resendBillingInvoice('11735', {
    transport: {},
    emailConfig: {
      fromName: 'TWT',
      fromEmail: 'faturamento@twt.com.br',
      alertEmail: ''
    },
    fetchInvoice: async () => ({
      invoices: [{
        id: '11735',
        clientDocument: '10629265000107',
        issuerDocument: '09123137000108',
        issuedAt: '2026-09-15',
        balance: 100,
        status: 0,
        statusLabel: 'Em aberto'
      }]
    }),
    listPending: async () => [],
    sendBillingEmail: async () => { sent = true; },
    removePending: async () => {}
  }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /antes de 16\/09\/2026/i);
    return true;
  });
  assert.equal(sent, false);
});

test('mantém estados financeiro, documental, de cobrança e pagamento independentes', () => {
  const invoice = {
    id: '11756',
    dueAt: '2026-09-10',
    status: 0,
    statusLabel: 'Em aberto',
    client: 'BHZ',
    clientDocument: '11280282000144'
  };
  const control = invoiceControl(invoice, {
    now: new Date('2026-09-13T12:00:00Z'),
    pending: { reason: 'doccob' },
    logs: [{ status: 'delivered', email: 'financeiro@example.com' }],
    bankRecord: { state: 'ready', bank: 'itau', bankSlipId: 'boleto-1' }
  });
  assert.equal(control.financial.code, 'overdue');
  assert.equal(control.documents.code, 'awaiting_doccob');
  assert.equal(control.collection.code, 'delivered');
  assert.equal(control.payment.code, 'registered');

  const ted = invoiceControl({
    ...invoice,
    client: 'RS WHITE MARTINS GASES INDUSTRIAIS LTDA'
  });
  assert.equal(ted.payment.code, 'ted_doc');
});

test('fila unificada prioriza vencidas e reúne falhas de documentos e entrega', () => {
  const issues = buildUnifiedIssues({
    now: new Date('2026-09-13T12:00:00Z'),
    pending: [{
      invoiceId: '100',
      clientName: 'Cliente vencido',
      clientCnpj: '11280282000144',
      reason: 'doccob',
      dueAt: '2026-09-10',
      lastCheckedAt: '2026-09-13T10:00:00Z'
    }],
    logs: [{
      id: 'log-1',
      invoiceId: '101',
      clientName: 'Cliente e-mail',
      status: 'hard_bounce',
      email: 'invalido@example.com',
      createdAt: '2026-09-13T11:00:00Z'
    }]
  });
  assert.equal(issues.length, 2);
  assert.equal(issues[0].invoiceId, '100');
  assert.equal(issues[0].priority, 'critical');
  assert.equal(issues[0].action, 'documents');
  assert.equal(issues[1].type, 'email');
  assert.equal(issues[1].action, 'logs');
});

test('fila direciona boleto e falha geral para a ação contextual correta', () => {
  const issues = buildUnifiedIssues({
    pending: [{
      invoiceId: '200',
      reason: 'processing_error',
      message: 'Falha ao gerar boleto no Itaú.'
    }, {
      invoiceId: '201',
      reason: 'processing_error',
      message: 'Falha inesperada no processamento.'
    }]
  });
  assert.equal(issues.find((issue) => issue.invoiceId === '200').action, 'payment');
  assert.equal(issues.find((issue) => issue.invoiceId === '201').action, 'invoice');
});

test('fatura ausente na Brudam fica somente no histórico e não volta às pendências', () => {
  const message = 'Fatura não encontrada na Brudam.';
  assert.equal(isTerminalBillingFailure({ message }), true);
  const issues = buildUnifiedIssues({
    pending: [{
      invoiceId: '11779',
      reason: 'processing_error',
      message
    }],
    logs: [{
      id: 'erro-11779',
      invoiceId: '11779',
      status: 'error',
      message
    }, {
      id: 'bounce-resolvivel',
      invoiceId: '11780',
      status: 'hard_bounce',
      email: 'corrigir@example.com',
      message: 'Destinatário rejeitado.'
    }]
  });
  assert.deepEqual(issues.map((issue) => issue.invoiceId), ['11780']);
});

test('histórico da fatura combina emissão, boleto, pendência, e-mails e vencimento', () => {
  const timeline = buildInvoiceTimeline({
    invoice: { id: '11756', issuedAt: '2026-09-01', dueAt: '2026-09-20' },
    pending: { reason: 'contacts', lastCheckedAt: '2026-09-03T12:00:00Z' },
    bankRecord: { state: 'ready', bank: 'itau', bankSlipId: 'boleto', createdAt: '2026-09-02T12:00:00Z' },
    logs: [{ status: 'submitted', event: 'initial', createdAt: '2026-09-04T12:00:00Z', email: 'a@b.com' }]
  });
  assert.deepEqual(new Set(timeline.map((event) => event.type)), new Set([
    'invoice', 'payment', 'pending', 'email', 'due'
  ]));
});

test('interface expõe cadastro, pendências e logs sem criar várias funções serverless', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'faturamento', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'faturamento', 'cobranca.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'faturamento', 'app.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api', 'faturamento', 'cobranca.js'), 'utf8');
  assert.match(html, /data-billing-area="collection"/);
  assert.match(html, /id="categoryForm"/);
  assert.match(html, /id="pendingRows"/);
  assert.match(html, /id="collectionLogsForm"/);
  assert.match(html, /id="previousLogPage"/);
  assert.match(html, /id="categoryDeleteModal"/);
  assert.match(html, /id="emailLogModal"/);
  assert.match(html, /id="emailLogBody"/);
  assert.match(html, /id="invoiceDetail"/);
  assert.match(html, /id="invoiceDetailResend"/);
  assert.match(html, /id="invoiceDetailDocuments"/);
  assert.match(html, /id="invoiceDetailWhatsApp"/);
  assert.match(html, /id="pendingIssueSummary"/);
  assert.match(html, /data-collection-section="collectionContactsSection"/);
  assert.match(html, /data-collection-section="pendingDoccobSection"/);
  assert.match(html, /data-collection-section="collectionLogsSection"/);
  assert.match(html, /id="pendingDoccobSection"[\s\S]*?hidden>/);
  assert.match(html, /id="collectionLogsSection"[\s\S]*?hidden>/);
  assert.match(source, /route, \.\.\.query/);
  assert.match(source, /const filters = logFilters\(\);[\s\S]*setLoading\(true\)/);
  assert.doesNotMatch(source, /window\.confirm\(`Excluir \$\{category\.name\}/);
  assert.match(source, /openEmailLogModal\(record, previewButton\)/);
  assert.match(source, /Atualizar Contatos/);
  assert.match(source, /Envio ✔️/);
  assert.match(source, /Envio ❌/);
  assert.match(source, /method: 'PATCH'/);
  assert.match(source, /Object\.assign\(contact, saved\)/);
  assert.doesNotMatch(source, /const setContactEnabled[\s\S]*?await loadCategories\(\);[\s\S]*?const syncContacts/);
  assert.match(source, /panel\.hidden = panel\.id !== sectionId/);
  assert.match(source, /setCollectionSection\(state\.collectionSection\)/);
  assert.match(source, /billing:open-documents/);
  assert.match(source, /billing:open-invoice-detail/);
  assert.match(source, /Conferir documentos/);
  assert.match(source, /Conferir boleto/);
  assert.match(source, /pendingFilter: 'all'/);
  assert.match(source, /className = 'pending-summary-filter'/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /record\.priority === 'critical'/);
  assert.match(appSource, /route=resend/);
  assert.match(appSource, /navigator\.clipboard/);
  assert.match(apiSource, /query\.route === 'webhook'/);
  assert.match(apiSource, /query\.route === 'contacts-sync'/);
  assert.match(apiSource, /query\.route === 'invoice-detail'/);
  assert.match(apiSource, /query\.route === 'resend'/);
  assert.match(apiSource, /req\.method === 'GET' \|\| req\.method === 'HEAD'/);
  assert.equal(fs.existsSync(path.join(root, 'api', 'faturamento', 'cobranca.js')), true);
});
