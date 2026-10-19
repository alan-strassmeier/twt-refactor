const test = require('node:test');
const assert = require('node:assert/strict');
const {
  previewJointBilling,
  sendJointBilling
} = require('../server/faturamento/cobranca-conjunta');
const { jointBillingSubject, jointBillingText } = require('../server/faturamento/cobranca-email');
const { processWebhookPayload } = require('../server/faturamento/cobranca-webhook');
const { processInvoiceEvent } = require('../server/faturamento/cobranca-processor');
const billingStore = require('../server/faturamento/cobranca-store');

const CNPJ = '12345678000190';
const category = {
  cnpj: CNPJ,
  name: 'Empresa Exemplo',
  billingMethod: 'ted_doc',
  contacts: [
    { firstName: 'Ana', lastName: '', email: 'ana@example.com', enabled: true },
    { firstName: 'Beto', lastName: '', email: 'beto@example.com', enabled: true },
    { firstName: 'Inativo', lastName: '', email: 'inativo@example.com', enabled: false }
  ]
};
const invoices = [
  { id: '101', clientDocument: CNPJ, status: '0', balance: 50.25, total: 50.25,
    issuedAt: '2026-10-01', dueAt: '2026-10-10' },
  { id: '102', clientDocument: CNPJ, status: '0', balance: 20, total: 20,
    issuedAt: '2026-10-02', dueAt: '2026-10-12' }
];

const mockDependencies = (overrides = {}) => {
  const sent = [];
  const claims = [];
  const saves = [];
  const releases = [];
  const logs = [];
  const references = [];
  const calls = [];
  return {
    sent, claims, saves, releases, logs, references, calls,
    getCategory: async () => category,
    getInvoiceBlocks: async (ids) => new Map(ids.map((id) => [id, null])),
    getJointDeliveries: async (ids) => new Map(ids.map((id) => [id, null])),
    fetchInvoices: async (query) => {
      calls.push(query);
      return { invoices, pagination: { allCompanyInvoicesLoaded: true, hasMore: false } };
    },
    fetchCurrentInvoice: async ({ id }) => ({ invoices: invoices.filter((invoice) => invoice.id === id) }),
    findDoccobForInvoice: async () => ({ invoice: { issuerCnpj: '00000000000000' } }),
    fetchInvoicePdfData: async (id) => ({
      invoice: { id, status: '0', balance: invoices.find((invoice) => invoice.id === id).balance,
        total: invoices.find((invoice) => invoice.id === id).total, payment: { type: 'ted_doc' } },
      client: { document: CNPJ }
    }),
    buildInvoicePdf: async () => Buffer.from('PDF'),
    emailConfig: { fromName: 'TWT LOG', fromEmail: 'faturamento@twt.com.br' },
    transport: {},
    sendJointBillingEmail: async (request) => {
      sent.push(request);
      return { messageId: 'smtp-1', accepted: ['ana@example.com', 'beto@example.com'], rejected: [] };
    },
    claimDelivery: async (...args) => { claims.push(args); return true; },
    saveDelivery: async (...args) => saves.push(args),
    releaseDeliveryClaim: async (...args) => releases.push(args),
    saveDeliveryReference: async (...args) => references.push(args),
    addLog: async (record) => logs.push(record),
    now: () => new Date('2026-10-18T15:00:00Z'),
    ...overrides
  };
};

test('prévia lista apenas faturas vencidas em aberto e marca bloqueios sem escondê-las', async () => {
  const dependencies = mockDependencies({ getInvoiceBlocks: async (ids) =>
    new Map(ids.map((id) => [id, { blocked: id === '102' }])) });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102']);
  assert.equal(preview.invoices[1].blocked, true);
  assert.equal(preview.blockedCount, 1);
  assert.equal(preview.totalBalance, 70.25);
  assert.equal(preview.recipients.length, 2);
  assert.equal(dependencies.calls[0].fresh, true);
  assert.equal(dependencies.calls[0]['vencimento[lte]'], '2026-10-16');
});

test('envio conjunto segue o corte automático: inclui dois dias de atraso, exclui ontem e datas futuras', async () => {
  const dependencies = mockDependencies({ fetchInvoices: async () => ({
    invoices: [
      ...invoices,
      { ...invoices[0], id: '107', dueAt: '2026-10-16' },
      { ...invoices[0], id: '108', dueAt: '2026-10-17' },
      { ...invoices[0], id: '103', dueAt: '2026-10-18' },
      { ...invoices[0], id: '104', dueAt: '2026-10-19' },
      { ...invoices[0], id: '105', dueAt: '' },
      { ...invoices[0], id: '106', status: '1' }
    ],
    pagination: { allCompanyInvoicesLoaded: true, hasMore: false }
  }) });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102', '107']);
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102', '103'] }, dependencies),
    /lista de faturas vencidas em aberto mudou/);
  assert.equal(dependencies.sent.length, 0);
});

test('envio conjunto manda uma mensagem, dois PDFs e registra ambas as faturas', async () => {
  const dependencies = mockDependencies();
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.equal(dependencies.sent.length, 1);
  assert.deepEqual(dependencies.sent[0].invoiceIds, ['101', '102']);
  assert.equal(dependencies.sent[0].recipients.length, 2);
  assert.deepEqual(dependencies.sent[0].attachments.map((item) => item.filename),
    ['fatura-101.pdf', 'fatura-102.pdf']);
  assert.equal(dependencies.sent[0].totalBalance, 70.25);
  assert.equal(jointBillingSubject, 'Faturas vencidas');
  assert.equal(dependencies.claims.length, 3);
  assert.equal(dependencies.saves[0][3].state, 'sent');
  assert.deepEqual(dependencies.logs.map((record) => record.invoiceId), ['101', '102']);
  assert.deepEqual(dependencies.references[0][1].invoiceIds, ['101', '102']);
  assert.match(dependencies.sent[0].clientReference, /^twt-joint-/);
});

test('não envia se uma fatura for liquidada antes do SMTP', async () => {
  let reads = 0;
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => {
      reads += 1;
      const invoice = invoices.find((item) => item.id === id);
      return { invoices: [{ ...invoice, balance: reads >= 4 && id === '102' ? 0 : invoice.balance }] };
    }
  });
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies),
    /não está mais confirmada como vencida e aberta/);
  assert.equal(dependencies.sent.length, 0);
  assert.equal(dependencies.claims.length, 0);
});

test('não envia se o vencimento mudar antes do SMTP', async () => {
  let reads = 0;
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => {
      reads += 1;
      const invoice = invoices.find((item) => item.id === id);
      return { invoices: [{ ...invoice, dueAt: reads >= 4 && id === '102'
        ? '2026-10-18' : invoice.dueAt }] };
    }
  });
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies),
    /não está mais confirmada como vencida e aberta/);
  assert.equal(dependencies.sent.length, 0);
});

test('não envia se algum DOCCOB faltar', async () => {
  const dependencies = mockDependencies({ findDoccobForInvoice: async ({ invoiceId }) =>
    invoiceId === '102' ? null : { invoice: { issuerCnpj: '00000000000000' } } });
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies), /DOCCOB/);
  assert.equal(dependencies.sent.length, 0);
});

test('bloqueio de fatura impede qualquer envio conjunto', async () => {
  const dependencies = mockDependencies({ getInvoiceBlocks: async (ids) =>
    new Map(ids.map((id) => [id, { blocked: id === '102' }])) });
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies), /bloqueado/);
  assert.equal(dependencies.sent.length, 0);
});

test('erro SMTP incerto mantém reserva e exige conferência, sem novo envio automático', async () => {
  const dependencies = mockDependencies({ sendJointBillingEmail: async () => {
    throw new Error('SMTP timeout');
  } });
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies);
  assert.equal(result.status, 'review');
  assert.equal(dependencies.releases.length, 0);
  assert.equal(dependencies.saves[0][3].state, 'review');
  assert.deepEqual(dependencies.logs.map((record) => record.status), ['review', 'review']);
});

test('falha de autenticação SMTP libera a reserva para nova tentativa', async () => {
  const dependencies = mockDependencies({ sendJointBillingEmail: async () => {
    throw Object.assign(new Error('Falha de autenticação'), { code: 'EAUTH' });
  } });
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies), /autenticação/);
  assert.equal(dependencies.releases.length, 3);
  assert.deepEqual(dependencies.logs.map((record) => record.status), ['error', 'error']);
});

test('mudança parcial de saldo interrompe o lote antes do SMTP', async () => {
  let reads = 0;
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => {
      reads += 1;
      const invoice = invoices.find((item) => item.id === id);
      return { invoices: [{ ...invoice, balance: reads >= 4 && id === '102' ? 19 : invoice.balance }] };
    }
  });
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies), /não está mais confirmada/);
  assert.equal(dependencies.sent.length, 0);
});

test('webhook de cobrança conjunta registra confirmação para cada fatura', async () => {
  const dependencies = mockDependencies();
  await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies);
  const [reference, savedReference] = dependencies.references[0];
  const records = [];
  let delivery = { state: 'sent' };
  const webhookStore = {
    getDeliveryReference: async () => savedReference,
    claimWebhookEvent: async () => true,
    releaseWebhookEvent: async () => true,
    getDelivery: async () => delivery,
    saveDelivery: async (_event, _id, _email, record) => { delivery = record; },
    addLog: async (record) => records.push(record)
  };
  const result = await processWebhookPayload({
    event_name: ['delivered'],
    webhook_request_id: 'joint-webhook-1',
    event_message: [{ request_id: 'request-1', email_info: {
      client_reference: reference, email_reference: 'zepto-1',
      to: { email_address: [{ address: 'ana@example.com' }] }
    } }]
  }, {
    store: webhookStore,
    now: () => new Date('2026-10-18T16:00:00Z')
  });
  assert.equal(result.processed, 1);
  assert.deepEqual(records.map((record) => record.invoiceId), ['101', '102']);
  assert.deepEqual(records.map((record) => record.status), ['delivered', 'delivered']);
  assert.equal(delivery.state, 'sent');
  await processWebhookPayload({
    event_name: ['delivered'], webhook_request_id: 'joint-webhook-2',
    event_message: [{ request_id: 'request-2', email_info: {
      client_reference: reference, email_reference: 'zepto-2',
      to: { email_address: [{ address: 'beto@example.com' }] }
    } }]
  }, { store: webhookStore, now: () => new Date('2026-10-18T16:01:00Z') });
  assert.equal(delivery.state, 'delivered');
});

test('mensagem contém números, empresa, pagamento e soma em reais', () => {
  assert.match(jointBillingText({ companyName: 'Empresa Exemplo', invoiceIds: ['101', '102'],
    paymentMethod: 'Transferência TED/DOC', totalBalance: 70.25 }),
  /Aviso de Faturamento das faturas 101, 102[\s\S]*Prezado\(a\) Empresa Exemplo[\s\S]*Valor Total: R\$\s70,25/);
});

test('cobrança automática não duplica o evento já reservado pelo envio conjunto', async () => {
  let prepared = false;
  const outcome = await processInvoiceEvent({
    event: 'initial', invoice: invoices[0], context: {
      now: () => new Date('2026-10-18T15:00:00Z'),
      summary: { alreadySent: 0 },
      pendingByInvoice: new Map(),
      getInvoiceBlock: async () => null,
      fetchPendingInvoice: async () => ({ invoices: [invoices[0]] }),
      findDoccobForInvoice: async () => ({ invoice: { issuerCnpj: '00000000000000' } }),
      getDelivery: async (event, id, email) => event === 'joint' && id === '101'
        && email === '__company__' ? { state: 'sent', billingEvent: 'initial' } : null,
      fetchInvoicePdfData: async () => { prepared = true; throw new Error('Não deveria preparar documentos'); }
    }
  });
  assert.equal(outcome.skipped, 'joint_delivery');
  assert.equal(prepared, false);
});

test('consulta bloqueios e reservas em lotes Redis sem uma chamada por fatura', async () => {
  const commands = [];
  const command = async (...args) => {
    commands.push(args);
    return [null, JSON.stringify({ blocked: true })];
  };
  const blocks = await billingStore.getInvoiceBlocks(['101', '102'], command);
  const deliveries = await billingStore.getJointDeliveries(['101', '102'], command);
  assert.equal(commands.length, 2);
  assert.equal(commands[0][0], 'HMGET');
  assert.equal(commands[1][0], 'HMGET');
  assert.equal(blocks.get('102').blocked, true);
  assert.equal(deliveries.get('102').blocked, true);
});
