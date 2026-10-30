const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listJointBilling,
  previewJointBilling,
  refreshJointBillingInvoice,
  prepareJointBillingInvoice,
  confirmJointDelivery,
  sendJointBilling: sendJointBillingCore
} = require('../server/faturamento/cobranca-conjunta');
const { savePreparedPackage, loadPreparedPackage } = require('../server/faturamento/cobranca-conjunta-cache');
const { jointBillingSubject, jointBillingText, jointBillingHtml, sendJointBillingEmail,
  zohoConfig } = require('../server/faturamento/cobranca-email');
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
    previewSecret: 'test-only-preview-secret-12345678901234567890',
    waitBeforeInvoiceRetry: async () => {},
    ...overrides
  };
};

const sendJointBilling = async ({ cnpj, invoiceIds }, dependencies) => {
  const preview = await previewJointBilling(cnpj, dependencies);
  const invoiceProofs = invoiceIds.map((id) => ({ id,
    proof: preview.invoices.find((invoice) => invoice.id === id)?.proof }));
  return sendJointBillingCore({ cnpj, invoiceIds, invoiceProofs }, dependencies);
};

test('lista inicial não consulta faturas individuais e mantém cada uma pendente para conferência separada', async () => {
  const dependencies = mockDependencies({ fetchCurrentInvoice: async () => {
    throw new Error('A lista inicial não deve consultar faturas individuais');
  } });
  const preview = await listJointBilling(CNPJ, dependencies);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102']);
  assert.ok(preview.invoices.every((invoice) => invoice.unverified && invoice.blocked && !invoice.proof));
  assert.equal(dependencies.calls.length, 1);
  const refreshed = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '101' },
    mockDependencies());
  assert.equal(refreshed.invoice.unverified, false);
  assert.ok(refreshed.invoice.proof);
});

test('limite HTTP 429 na listagem inicial informa o motivo sem iniciar conferências individuais', async () => {
  const dependencies = mockDependencies({ fetchInvoices: async () => {
    throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
  } });
  await assert.rejects(listJointBilling(CNPJ, dependencies), /Brudam limitou a consulta inicial \(HTTP 429\)/);
});

test('prévia lista apenas faturas vencidas em aberto e marca bloqueios sem escondê-las', async () => {
  const dependencies = mockDependencies({ getInvoiceBlocks: async (ids) =>
    new Map(ids.map((id) => [id, { blocked: id === '102' }])) });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102']);
  assert.equal(preview.invoices[1].blocked, true);
  assert.equal(preview.invoices[1].unverified, false);
  assert.equal(preview.invoices[1].blockKind, 'manual');
  assert.match(preview.invoices[1].blockReason, /bloqueio manual/);
  assert.equal(preview.blockedCount, 1);
  assert.equal(preview.totalBalance, 70.25);
  assert.equal(preview.recipients.length, 2);
  assert.equal(dependencies.calls[0].fresh, true);
  assert.equal(dependencies.calls[0]['vencimento[lte]'], '2026-10-16');
});

test('prévia exclui faturas que a listagem por CNPJ mostra abertas mas a consulta individual mostra liquidadas', async () => {
  const listed = [
    ...invoices,
    { ...invoices[0], id: '11347', balance: 1851.36, total: 2135.40 },
    { ...invoices[0], id: '11348', balance: 12, total: 12 }
  ];
  const exactQueries = [];
  const dependencies = mockDependencies({
    fetchInvoices: async () => ({ invoices: listed, pagination: { allCompanyInvoicesLoaded: true } }),
    fetchCurrentInvoice: async (query) => {
      exactQueries.push(query);
      const listedInvoice = listed.find((invoice) => invoice.id === query.id);
      return { invoices: [{ ...listedInvoice,
        ...(query.id === '11347' ? { status: '1', balance: 0 } : {}),
        ...(query.id === '11348' ? { balance: 0 } : {})
      }] };
    }
  });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102']);
  assert.equal(preview.totalBalance, 70.25);
  assert.deepEqual(exactQueries.map((query) => query.id), ['101', '102', '11347', '11348']);
  assert.ok(exactQueries.every((query) => query.fresh === true));
  await assert.rejects(sendJointBilling({ cnpj: CNPJ,
    invoiceIds: ['101', '102', '11347'] }, dependencies), /confirmação da fatura 11347 é inválida/);
  assert.equal(dependencies.sent.length, 0);
});

test('prévia mostra fatura não confirmada como bloqueada, sem impedir as outras', async () => {
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => ({ invoices: id === '102' ? [] : [invoices[0]] })
  });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102']);
  assert.equal(preview.invoices[1].blocked, true);
  assert.equal(preview.invoices[1].unverified, true);
  assert.equal(preview.invoices[1].balance, null);
  assert.match(preview.invoices[1].blockReason, /situação financeira inequívoca/);
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies),
    /confirmação da fatura 102 é inválida/);
  assert.equal(dependencies.sent.length, 0);
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101'] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(dependencies.sent[0].invoiceIds, ['101']);
});

test('atualização de erro consulta só a fatura indicada, sem refazer a lista da empresa', async () => {
  const queried = [];
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => {
      queried.push(id);
      return { invoices: invoices.filter((invoice) => invoice.id === id) };
    }
  });
  const result = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '102' }, dependencies);
  assert.deepEqual(queried, ['102']);
  assert.equal(dependencies.calls.length, 0);
  assert.equal(result.invoice.unverified, false);
  assert.equal(result.invoice.blocked, false);
  assert.equal(result.invoice.balance, 20);
});

test('conferência guarda os dados da fatura para enviar sem buscá-los novamente na Brudam', async () => {
  let reads = 0;
  const dependencies = mockDependencies({ fetchInvoicePdfData: async (id) => {
    reads += 1;
    return { invoice: { id, status: '0', balance: 50.25, total: 50.25,
      issuedAt: '2026-10-01', dueAt: '2026-10-10', payment: { type: 'ted_doc' } },
    client: { document: CNPJ } };
  } });
  const checked = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '101',
    includePdfData: true }, dependencies);
  assert.equal(reads, 1);
  assert.ok(checked.invoice.proof);
  assert.ok(checked.invoice.snapshot);
  dependencies.fetchInvoicePdfData = async () => { throw new Error('Não deve repetir a busca'); };
  const result = await sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101'],
    invoiceProofs: [{ id: '101', proof: checked.invoice.proof }],
    invoiceSnapshots: [{ id: '101', snapshot: checked.invoice.snapshot }] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.equal(reads, 1);
  assert.equal(dependencies.sent.length, 1);
});

test('após HTTP 429 só a fatura que falhou precisa de nova consulta', async () => {
  const reads = [];
  let rateLimited = true;
  const dependencies = mockDependencies({ fetchInvoicePdfData: async (id) => {
    reads.push(id);
    if (id === '102' && rateLimited) {
      throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    }
    const invoice = invoices.find((item) => item.id === id);
    return { invoice: { ...invoice, payment: { type: 'ted_doc' } },
      client: { document: CNPJ } };
  } });
  const first = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '101',
    includePdfData: true }, dependencies);
  const failed = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '102',
    includePdfData: true }, dependencies);
  assert.equal(failed.invoice.upstreamStatus, 429);
  assert.ok(first.invoice.snapshot);
  rateLimited = false;
  const second = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '102',
    includePdfData: true }, dependencies);
  dependencies.fetchInvoicePdfData = async () => { throw new Error('Não deve repetir consultas'); };
  const result = await sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101', '102'],
    invoiceProofs: [first, second].map(({ id, invoice }) => ({ id, proof: invoice.proof })),
    invoiceSnapshots: [first, second].map(({ id, invoice }) => ({ id, snapshot: invoice.snapshot }))
  }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(reads, ['101', '102', '102']);
});

test('prepara cada fatura uma vez; falha isolada não refaz conferência nem anexos já prontos', async () => {
  const cache = new Map();
  const command = async (operation, ...args) => {
    if (operation === 'SET') { cache.set(args[0], args[1]); return 'OK'; }
    if (operation === 'MGET') return args.map((key) => cache.get(key) || null);
    if (operation === 'DEL') { args.forEach((key) => cache.delete(key)); return args.length; }
    throw new Error(`Comando inesperado: ${operation}`);
  };
  const reads = [];
  const prepared = [];
  let failSecond = true;
  const dependencies = mockDependencies({
    fetchInvoicePdfData: async (id) => {
      reads.push(id);
      const invoice = invoices.find((item) => item.id === id);
      return { invoice: { ...invoice, payment: { type: 'ted_doc' } },
        client: { document: CNPJ } };
    },
    findDoccobForInvoice: async ({ invoiceId: id }) => {
      prepared.push(id);
      if (id === '102' && failSecond) throw Object.assign(new Error('limite'), { statusCode: 429 });
      return { invoice: { issuerCnpj: '00000000000000' } };
    },
    savePreparedPackage: (args, options) => savePreparedPackage(args, { ...options, command }),
    loadPreparedPackage: (args, options) => loadPreparedPackage(args, { ...options, command })
  });
  const checks = await Promise.all(['101', '102'].map((id) => refreshJointBillingInvoice({
    cnpj: CNPJ, invoiceId: id, includePdfData: true
  }, dependencies)));
  const prepare = (checked) => prepareJointBillingInvoice({ cnpj: CNPJ,
    invoiceId: checked.id, proof: checked.invoice.proof, snapshot: checked.invoice.snapshot
  }, dependencies);
  const first = await prepare(checks[0]);
  await assert.rejects(prepare(checks[1]), (error) => error.invoiceId === '102'
    && error.upstreamStatus === 429 && error.retryStage === 'prepare');
  failSecond = false;
  const second = await prepare(checks[1]);
  dependencies.fetchInvoicePdfData = async () => { throw new Error('Consulta repetida'); };
  dependencies.findDoccobForInvoice = async () => { throw new Error('Anexos repetidos'); };
  const result = await sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101', '102'],
    invoiceProofs: checks.map(({ id, invoice }) => ({ id, proof: invoice.proof })),
    invoicePackages: [{ id: '101', token: first.token }, { id: '102', token: second.token }]
  }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(reads, ['101', '102']);
  assert.deepEqual(prepared, ['101', '102', '102']);
  assert.equal(dependencies.sent.length, 1);
  assert.deepEqual(dependencies.sent[0].attachments.map(({ filename }) => filename),
    ['fatura-101.pdf', 'fatura-102.pdf']);
});

test('anexos temporários recusam outra fatura e expiração sem enviar e-mail', async () => {
  const cache = new Map();
  const command = async (operation, ...args) => {
    if (operation === 'SET') { cache.set(args[0], args[1]); return 'OK'; }
    if (operation === 'MGET') return args.map((key) => cache.get(key) || null);
    return null;
  };
  const proof = 'prova-da-fatura';
  const saved = await savePreparedPackage({ cnpj: CNPJ, invoiceId: '101', proof,
    attachments: [{ filename: 'fatura-101.pdf', contentType: 'application/pdf', content: Buffer.from('PDF') }]
  }, { secret: 'test-only-preview-secret-12345678901234567890', command,
    now: () => new Date('2026-10-18T15:00:00Z') });
  const options = { secret: 'test-only-preview-secret-12345678901234567890', command,
    now: () => new Date('2026-10-18T15:00:00Z') };
  await assert.rejects(loadPreparedPackage({ token: saved.token, cnpj: CNPJ,
    invoiceId: '102', proof }, options), /não correspondem/);
  await assert.rejects(loadPreparedPackage({ token: saved.token, cnpj: CNPJ,
    invoiceId: '101', proof }, { ...options,
    now: () => new Date('2026-10-18T16:00:00Z') }), /expiraram/);
});

test('cache perdido bloqueia somente o pacote afetado antes de qualquer envio', async () => {
  const dependencies = mockDependencies({ loadPreparedPackage: async ({ invoiceId: id }) => {
    if (id === '102') throw new Error('Pacote expirado');
    return [{ filename: 'fatura-101.pdf', contentType: 'application/pdf', content: Buffer.from('PDF') }];
  } });
  const preview = await previewJointBilling(CNPJ, dependencies);
  await assert.rejects(sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101', '102'],
    invoiceProofs: preview.invoices.map(({ id, proof }) => ({ id, proof })),
    invoicePackages: [{ id: '101', token: 'primeiro' }, { id: '102', token: 'segundo' }]
  }, dependencies), (error) => error.invoiceId === '102' && error.retryStage === 'prepare'
    && error.retryable === true);
  assert.equal(dependencies.sent.length, 0);
  assert.equal(dependencies.claims.length, 0);
});

test('recusa dados de fatura adulterados no navegador sem acessar documentos', async () => {
  let documents = 0;
  const dependencies = mockDependencies({
    findDoccobForInvoice: async () => {
      documents += 1;
      return null;
    },
    fetchInvoicePdfData: async (id) => ({
      invoice: { id, status: '0', balance: 50.25, total: 50.25,
        issuedAt: '2026-10-01', dueAt: '2026-10-10', payment: { type: 'ted_doc' } },
      client: { document: CNPJ }
    })
  });
  const checked = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '101',
    includePdfData: true }, dependencies);
  const changed = `${checked.invoice.snapshot.slice(0, -1)}${checked.invoice.snapshot.endsWith('x') ? 'y' : 'x'}`;
  await assert.rejects(sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101'],
    invoiceProofs: [{ id: '101', proof: checked.invoice.proof }],
    invoiceSnapshots: [{ id: '101', snapshot: changed }] },
  dependencies), /dados guardados da fatura 101 são inválidos/);
  assert.equal(documents, 0);
});

test('atualização remove da prévia a fatura que deixou de estar aberta', async () => {
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async () => ({ invoices: [{ ...invoices[1], status: '1', balance: 0 }] })
  });
  const result = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '102' }, dependencies);
  assert.deepEqual(result, { id: '102', removed: true });
  assert.equal(dependencies.calls.length, 0);
});

test('resposta financeira incompleta continua pendente em vez de sumir da lista', async () => {
  const dependencies = mockDependencies({ fetchInvoicePdfData: async (id) => ({
    invoice: { id, status: null, balance: null, issuedAt: '2026-10-02',
      dueAt: '2026-10-12' }, client: { document: CNPJ }
  }) });
  const result = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '102',
    includePdfData: true }, dependencies);
  assert.equal(result.removed, false);
  assert.equal(result.invoice.unverified, true);
  assert.match(result.invoice.blockReason, /situação financeira completa/);
});

test('HTTP 429 mantém apenas a fatura reconsultada bloqueada', async () => {
  const queried = [];
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => {
      queried.push(id);
      throw Object.assign(new Error('Too many requests'), { statusCode: 429 });
    }
  });
  const result = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '102' }, dependencies);
  assert.ok(queried.length >= 1);
  assert.ok(queried.every((id) => id === '102'));
  assert.equal(dependencies.calls.length, 0);
  assert.equal(result.invoice.unverified, true);
  assert.equal(result.invoice.blocked, true);
  assert.equal(result.invoice.upstreamStatus, 429);
  assert.match(result.invoice.blockReason, /HTTP 429/);
});

test('consulta individual vazia transitória é repetida antes de bloquear a fatura', async () => {
  let attempts = 0;
  const dependencies = mockDependencies({ fetchCurrentInvoice: async ({ id }) => {
    if (id !== '102') return { invoices: [invoices[0]] };
    attempts += 1;
    return { invoices: attempts < 3 ? [] : [invoices[1]] };
  } });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.equal(attempts, 3);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102']);
  assert.equal(preview.invoices[1].blocked, false);
  assert.equal(preview.invoices[1].balance, 20);
});

test('erro HTTP 5xx transitório na consulta individual é repetido', async () => {
  let attempts = 0;
  const dependencies = mockDependencies({ fetchCurrentInvoice: async ({ id }) => {
    if (id !== '102') return { invoices: [invoices[0]] };
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('Falha temporária'), { statusCode: 502 });
    return { invoices: [invoices[1]] };
  } });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.equal(attempts, 3);
  assert.equal(preview.invoices[1].blocked, false);
});

test('prévia limita a três consultas individuais simultâneas para muitos vencimentos', async () => {
  const manyInvoices = Array.from({ length: 18 }, (_, index) => ({
    ...invoices[0], id: String(1000 + index)
  }));
  let active = 0;
  let maximum = 0;
  const dependencies = mockDependencies({
    fetchInvoices: async () => ({ invoices: manyInvoices, pagination: { allCompanyInvoicesLoaded: true } }),
    fetchCurrentInvoice: async ({ id }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { invoices: manyInvoices.filter((invoice) => invoice.id === id) };
    }
  });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.equal(preview.invoices.length, manyInvoices.length);
  assert.equal(preview.blockedCount, 0);
  assert.ok(maximum > 1 && maximum <= 3);
});

test('divergência de cliente fica visível, mas não pode entrar no envio', async () => {
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => ({ invoices: [{
      ...invoices.find((invoice) => invoice.id === id),
      ...(id === '102' ? { clientDocument: '99999999000199' } : {})
    }] })
  });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.equal(preview.invoices[1].blocked, true);
  assert.match(preview.invoices[1].blockReason, /cliente/);
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['102'] }, dependencies),
    /confirmação da fatura 102 é inválida/);
  assert.equal(dependencies.sent.length, 0);
});

test('prévia usa saldo e vencimento da consulta individual, não os valores antigos da listagem', async () => {
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => ({ invoices: [{
      ...invoices.find((invoice) => invoice.id === id),
      ...(id === '102' ? { balance: 15, dueAt: '2026-10-11' } : {})
    }] })
  });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.equal(preview.invoices[1].balance, 15);
  assert.equal(preview.invoices[1].dueAt, '2026-10-11');
  assert.equal(preview.totalBalance, 65.25);
});

test('envio conjunto segue o corte automático: inclui dois dias de atraso, exclui ontem e datas futuras', async () => {
  const listed = [
    ...invoices,
    { ...invoices[0], id: '107', dueAt: '2026-10-16' },
    { ...invoices[0], id: '108', dueAt: '2026-10-17' },
    { ...invoices[0], id: '103', dueAt: '2026-10-18' },
    { ...invoices[0], id: '104', dueAt: '2026-10-19' },
    { ...invoices[0], id: '105', dueAt: '' },
    { ...invoices[0], id: '106', status: '1' }
  ];
  const dependencies = mockDependencies({
    fetchInvoices: async () => ({
      invoices: listed,
      pagination: { allCompanyInvoicesLoaded: true, hasMore: false }
    }),
    fetchCurrentInvoice: async ({ id }) => ({ invoices: listed.filter((invoice) => invoice.id === id) })
  });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.deepEqual(preview.invoices.map((invoice) => invoice.id), ['101', '102', '107']);
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102', '103'] }, dependencies),
    /confirmação da fatura 103 é inválida/);
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
  assert.deepEqual(dependencies.sent[0].invoices, [
    { id: '101', dueAt: '2026-10-10', overdueDays: 8 },
    { id: '102', dueAt: '2026-10-12', overdueDays: 6 }
  ]);
  assert.equal(jointBillingSubject, 'Faturas vencidas');
  assert.equal(dependencies.claims.length, 3);
  assert.equal(dependencies.saves[0][3].state, 'sent');
  assert.deepEqual(dependencies.logs.map((record) => record.invoiceId), ['101', '102']);
  assert.deepEqual(dependencies.references[0][1].invoiceIds, ['101', '102']);
  assert.match(dependencies.sent[0].clientReference, /^twt-joint-/);
});

test('envio conjunto usa BILLING_ALERT_EMAIL em cópia sem alterar os destinatários principais', async () => {
  let message;
  await sendJointBillingEmail({
    recipients: [{ firstName: 'Ana', lastName: '', email: 'ana@example.com' }],
    companyName: 'Empresa Exemplo',
    invoices: [{ id: '101', overdueDays: 8 }],
    paymentMethod: 'Boleto bancário',
    totalBalance: 30.25,
    attachments: [],
    clientReference: 'test-joint-101',
    transport: { sendMail: async (value) => {
      message = value;
      return { messageId: 'smtp-1', accepted: ['ana@example.com', 'adrianoldepaula@gmail.com'], rejected: [] };
    } },
    config: zohoConfig({
      ZOHO_SMTP_USER: 'faturamento@twt.com.br',
      ZOHO_SMTP_PASSWORD: 'senha-de-teste',
      BILLING_ALERT_EMAIL: 'financeiro-interno@example.com'
    })
  });
  assert.deepEqual(message.to, [{ name: 'Ana', address: 'ana@example.com' }]);
  assert.equal(message.cc, 'financeiro-interno@example.com');
});

test('envio usa a liberação da prévia sem nova consulta financeira', async () => {
  let reads = 0;
  const dependencies = mockDependencies({ fetchCurrentInvoice: async ({ id }) => {
    reads += 1;
    return { invoices: invoices.filter((invoice) => invoice.id === id) };
  } });
  const preview = await previewJointBilling(CNPJ, dependencies);
  const readsAtRelease = reads;
  dependencies.fetchCurrentInvoice = async () => { throw new Error('Não deve reconfirmar'); };
  dependencies.fetchInvoices = async () => { throw new Error('Não deve refazer a listagem'); };
  const result = await sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101', '102'],
    invoiceProofs: preview.invoices.map(({ id, proof }) => ({ id, proof })) }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.equal(reads, readsAtRelease);
  assert.equal(dependencies.sent.length, 1);
});

test('envio não confere novamente o status financeiro ao gerar anexos', async () => {
  const dependencies = mockDependencies({ fetchInvoicePdfData: async (id) => ({
    invoice: { id, status: '1', balance: 0, total: 50.25, payment: { type: 'ted_doc' } },
    client: { document: CNPJ }
  }) });
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101'] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.equal(dependencies.sent.length, 1);
});

test('falha HTTP 429 ao preparar anexos identifica a fatura e permite tentar novamente', async () => {
  const dependencies = mockDependencies({ fetchInvoicePdfData: async (id) => {
    if (id === '102') throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    return { invoice: { id, status: '0', total: 50.25, balance: 50.25,
      payment: { type: 'ted_doc' } }, client: { document: CNPJ } };
  } });
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies),
    (error) => error.invoiceId === '102' && error.upstreamStatus === 429
      && error.retryable === true && /Fatura 102:.*HTTP 429/.test(error.message));
  assert.equal(dependencies.sent.length, 0);
});

test('boleto vencido sem registro gera erro definitivo sem repetir preparação', async () => {
  const dependencies = mockDependencies({
    getCategory: async () => ({ ...category, billingMethod: 'bank_slip' }),
    fetchInvoicePdfData: async (id) => ({
      invoice: { ...invoices.find((item) => item.id === id), payment: null },
      client: { document: CNPJ }
    }),
    generateInvoiceBankSlip: async () => {
      throw Object.assign(new Error('O vencimento da fatura já passou.'), { statusCode: 422 });
    }
  });
  const checked = await refreshJointBillingInvoice({ cnpj: CNPJ, invoiceId: '101',
    includePdfData: true }, dependencies);
  await assert.rejects(prepareJointBillingInvoice({ cnpj: CNPJ, invoiceId: '101',
    proof: checked.invoice.proof, snapshot: checked.invoice.snapshot }, dependencies),
  (error) => error.statusCode === 422 && error.retryable === false
    && error.invoiceId === '101' && /vencimento da fatura já passou/.test(error.message));
});

test('servidor recusa e-mail com mais de dez faturas antes de acessar documentos', async () => {
  const ids = Array.from({ length: 11 }, (_, index) => String(index + 1));
  await assert.rejects(sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ids },
    mockDependencies()), (error) => error.statusCode === 413 && /no máximo 10 faturas/.test(error.message));
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
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies),
    /confirmação da fatura 102 é inválida/);
  assert.equal(dependencies.sent.length, 0);
});

test('bloqueio bancário é identificado separadamente do manual na prévia e no envio', async () => {
  const dependencies = mockDependencies({ getInvoiceBlocks: async (ids) => new Map(ids.map((id) => [id,
    id === '101' ? { blocked: true } : { blocked: true, reason: 'bank_reconciliation' }
  ])) });
  const preview = await previewJointBilling(CNPJ, dependencies);
  assert.equal(preview.invoices[0].blockKind, 'manual');
  assert.equal(preview.invoices[1].blockKind, 'bank_reconciliation');
  assert.match(preview.invoices[1].blockReason, /conciliação bancária/);
  await assert.rejects(sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies),
    /confirmação da fatura 101 é inválida/);
  assert.equal(dependencies.sent.length, 0);
});

test('fatura bloqueada pode ser ignorada apenas neste envio, sem anexos ou logs para ela', async () => {
  const dependencies = mockDependencies({ getInvoiceBlocks: async (ids) =>
    new Map(ids.map((id) => [id, { blocked: id === '102' }])) });
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101'] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(dependencies.sent[0].invoiceIds, ['101']);
  assert.deepEqual(dependencies.sent[0].attachments.map((item) => item.filename), ['fatura-101.pdf']);
  assert.equal(dependencies.sent[0].totalBalance, 50.25);
  assert.deepEqual(dependencies.logs.map((record) => record.invoiceId), ['101']);
  assert.deepEqual(dependencies.claims.map((claim) => claim[1]).slice(1), ['101']);
  assert.match(dependencies.references[0][1].emailPreview.text, /Fatura 101: vencida há 8 dias/);
  assert.doesNotMatch(dependencies.references[0][1].emailPreview.text, /102/);
});

test('fatura ignorada pode mudar sem interromper as selecionadas', async () => {
  let reads = 0;
  const dependencies = mockDependencies({
    fetchCurrentInvoice: async ({ id }) => {
      if (id === '102') reads += 1;
      const invoice = invoices.find((item) => item.id === id);
      return { invoices: [{ ...invoice,
        ...(id === '102' && reads > 1 ? { status: '1', balance: 0 } : {}) }] };
    }
  });
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101'] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(dependencies.sent[0].invoiceIds, ['101']);
  assert.equal(reads, 1);
});

test('envio parcial não reconsulta as faturas liberadas, mesmo com muitas vencidas', async () => {
  const listed = [...invoices, ...Array.from({ length: 20 }, (_, index) => ({
    ...invoices[0], id: String(1000 + index)
  }))];
  const exactIds = [];
  const dependencies = mockDependencies({
    fetchInvoices: async () => ({ invoices: listed, pagination: { allCompanyInvoicesLoaded: true } }),
    fetchCurrentInvoice: async ({ id }) => {
      exactIds.push(id);
      return { invoices: listed.filter((invoice) => invoice.id === id) };
    }
  });
  const preview = await previewJointBilling(CNPJ, dependencies);
  exactIds.length = 0;
  const result = await sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101'],
    invoiceProofs: [{ id: '101', proof: preview.invoices.find((invoice) => invoice.id === '101').proof }] },
  dependencies);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(exactIds, []);
});

test('bloqueio posterior à liberação não provoca outra consulta', async () => {
  let blockReads = 0;
  const dependencies = mockDependencies({ getInvoiceBlocks: async (ids) => {
    blockReads += 1;
    return new Map(ids.map((id) => [id, { blocked: blockReads > 1 && id === '101' }]));
  } });
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101'] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.equal(blockReads, 1);
  assert.equal(dependencies.sent.length, 1);
});

test('DOCCOB ausente em fatura ignorada não impede o envio das demais', async () => {
  const dependencies = mockDependencies({ findDoccobForInvoice: async ({ invoiceId }) =>
    invoiceId === '102' ? null : { invoice: { issuerCnpj: '00000000000000' } } });
  const result = await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101'] }, dependencies);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(dependencies.sent[0].invoiceIds, ['101']);
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

test('recusa liberação adulterada e expirada antes de preparar documentos', async () => {
  let prepared = 0;
  const dependencies = mockDependencies({ fetchInvoicePdfData: async () => {
    prepared += 1;
    throw new Error('Não deve preparar documentos');
  } });
  const preview = await previewJointBilling(CNPJ, dependencies);
  const validProof = preview.invoices[0].proof;
  await assert.rejects(sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101'],
    invoiceProofs: [{ id: '101', proof: `${validProof.slice(0, -1)}x` }] }, dependencies), /inválida/);
  await assert.rejects(sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['102'],
    invoiceProofs: [{ id: '102', proof: validProof }] }, dependencies), /não corresponde/);
  const expired = mockDependencies({ ...dependencies, now: () => new Date('2026-10-18T15:31:00Z') });
  await assert.rejects(sendJointBillingCore({ cnpj: CNPJ, invoiceIds: ['101'],
    invoiceProofs: [{ id: '101', proof: validProof }] }, expired), /expirou/);
  assert.equal(prepared, 0);
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

test('webhook de cobrança conjunta identifica destinatário no formato aninhado do provedor', async () => {
  const dependencies = mockDependencies();
  await sendJointBilling({ cnpj: CNPJ, invoiceIds: ['101', '102'] }, dependencies);
  const [reference, savedReference] = dependencies.references[0];
  const records = [];
  let delivery = { state: 'review' };
  const webhookStore = {
    getDeliveryReference: async () => savedReference,
    claimWebhookEvent: async () => true,
    releaseWebhookEvent: async () => true,
    getDelivery: async () => delivery,
    saveDelivery: async (_event, _id, _email, record) => { delivery = record; },
    addLog: async (record) => records.push(record)
  };
  for (const [index, email] of ['ana@example.com', 'beto@example.com'].entries()) {
    const to = index === 0
      ? [{ email_address: { address: email, name: 'Destinatário' } }]
      : { email_address: { address: email, name: 'Destinatário' } };
    await processWebhookPayload({
      event_name: ['delivered'], webhook_request_id: `joint-nested-${index}`,
      event_message: [{ request_id: `nested-${index}`, email_info: {
        client_reference: reference, to
      } }]
    }, { store: webhookStore, now: () => new Date('2026-10-18T16:00:00Z') });
  }
  assert.deepEqual(records.map((record) => record.email), [
    'ana@example.com', 'ana@example.com', 'beto@example.com', 'beto@example.com'
  ]);
  assert.equal(delivery.state, 'delivered');
});

test('confirmação manual de entrega altera apenas o lote reservado e registra auditoria sem enviar e-mail', async () => {
  const clientReference = 'twt-joint-1234567890-0123456789abcdef';
  const batchId = '1234567890';
  const reference = {
    clientReference, jointBilling: true, event: 'joint', invoiceId: batchId,
    email: CNPJ, clientCnpj: CNPJ, clientName: 'Empresa Exemplo',
    invoiceIds: ['101', '102'], recipientEmails: ['ana@example.com', 'beto@example.com']
  };
  const records = new Map([
    [`joint:${batchId}:${CNPJ}`, { state: 'review', invoiceIds: ['101', '102'] }],
    ['joint:101:__company__', { state: 'review', batchId }],
    ['joint:102:__company__', { state: 'review', batchId }]
  ]);
  const logs = [];
  const dependencies = {
    getDeliveryReference: async (id) => id === clientReference ? reference : null,
    getDelivery: async (event, id, email) => records.get(`${event}:${id}:${email}`),
    saveDelivery: async (event, id, email, record) => records.set(`${event}:${id}:${email}`, record),
    addLog: async (record) => logs.push(record),
    now: () => new Date('2026-10-30T12:00:00Z')
  };
  await assert.rejects(confirmJointDelivery({ clientReference, confirmAllRecipients: false }, dependencies),
    /Confirme a entrega/);
  const result = await confirmJointDelivery({ clientReference, confirmAllRecipients: true }, dependencies);
  assert.equal(result.status, 'delivered');
  assert.equal(result.recipients, 2);
  assert.equal(records.get(`joint:${batchId}:${CNPJ}`).state, 'delivered');
  assert.equal(records.get('joint:101:__company__').state, 'delivered');
  assert.deepEqual(logs.map((record) => record.invoiceId), ['101', '102']);
  assert.ok(logs.every((record) => record.status === 'delivered'
    && record.confirmationSource === 'provider_panel'
    && record.email === 'ana@example.com, beto@example.com'));
  const repeated = await confirmJointDelivery({ clientReference, confirmAllRecipients: true }, dependencies);
  assert.equal(repeated.alreadyConfirmed, true);
  assert.equal(logs.length, 2);
});

test('confirmação manual não sobrescreve rejeição registrada pelo provedor', async () => {
  const clientReference = 'twt-joint-1234567890-0123456789abcdef';
  let saves = 0;
  await assert.rejects(confirmJointDelivery({ clientReference, confirmAllRecipients: true }, {
    getDeliveryReference: async () => ({
      clientReference, jointBilling: true, event: 'joint', invoiceId: '1234567890',
      email: CNPJ, invoiceIds: ['101'], recipientEmails: ['ana@example.com']
    }),
    getDelivery: async () => ({ state: 'review', recipientEvents: {
      'ana@example.com': { status: 'hard_bounce' }
    } }),
    saveDelivery: async () => { saves += 1; }
  }), /evento incompatível/);
  assert.equal(saves, 0);
});

test('mensagem contém números, empresa, pagamento e soma em reais', () => {
  const content = { companyName: 'Empresa Exemplo', invoices: [
    { id: '101', overdueDays: 8 }, { id: '102', overdueDays: 1 }
  ], paymentMethod: 'Transferência TED/DOC', totalBalance: 70.25 };
  assert.match(jointBillingText(content),
    /Aviso de Faturamento das faturas 101, 102[\s\S]*Fatura 101: vencida há 8 dias[\s\S]*Fatura 102: vencida há 1 dia[\s\S]*Valor Total: R\$\s70,25/);
  assert.match(jointBillingHtml(content), /Fatura 101: vencida há 8 dias/);
  assert.doesNotMatch(jointBillingText({ companyName: 'Empresa Exemplo', invoices: [
    { id: '101', overdueDays: 8 }
  ], paymentMethod: 'Transferência TED/DOC', totalBalance: 50.25 }), /Fatura 102/);
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
    if (args[0] === 'SMEMBERS') return args[1] === billingStore.KEYS.bankReconciliationIgnored
      ? ['101'] : [];
    return [null, JSON.stringify({ blocked: true })];
  };
  const blocks = await billingStore.getInvoiceBlocks(['101', '102'], command);
  const deliveries = await billingStore.getJointDeliveries(['101', '102'], command);
  assert.equal(commands.length, 4);
  assert.equal(commands[0][0], 'HMGET');
  assert.equal(commands[3][0], 'HMGET');
  assert.equal(blocks.get('101').reason, 'bank_reconciliation');
  assert.equal(blocks.get('102').blocked, true);
  assert.equal(deliveries.get('102').blocked, true);
});
