const test = require('node:test');
const assert = require('node:assert/strict');
const { jointProofNeedsRefresh, streamJointBillingInvoices,
  MAX_JOINT_ATTACHMENT_BYTES, MAX_JOINT_INVOICES_PER_BATCH, MAX_BATCH_WAIT_MS } =
  require('../faturamento/cobranca-batches');

test('divide o envio em e-mails de até 18 MB sem separar os anexos de uma fatura', async () => {
  const mb = 1024 * 1024;
  const sent = [];
  await streamJointBillingInvoices(['101', '102', '103', '104'].map((id) => ({ id })), {
    prepare: async ({ id }) => ({ 101: 10, 102: 8, 103: 9, 104: 4 })[id] * mb,
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    },
    onPrepareError: async () => { throw new Error('Não esperado'); }
  });
  assert.deepEqual(sent, [['101', '102'], ['103', '104']]);
});

test('divide grupos pequenos após dez faturas para evitar mensagens com muitos anexos', async () => {
  const sent = [];
  const invoices = Array.from({ length: MAX_JOINT_INVOICES_PER_BATCH * 2 + 1 },
    (_, index) => ({ id: String(index + 1) }));
  await streamJointBillingInvoices(invoices, {
    prepare: async () => 1024,
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    },
    onPrepareError: async () => { throw new Error('Não esperado'); }
  });
  assert.deepEqual(sent.map((group) => group.length), [10, 10, 1]);
});

test('anexo individual exatamente no limite ocupa um e-mail próprio', async () => {
  const sent = [];
  await streamJointBillingInvoices([{ id: '101' }, { id: '102' }], {
    prepare: async ({ id }) => id === '101' ? MAX_JOINT_ATTACHMENT_BYTES : 1,
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    },
    onPrepareError: async () => { throw new Error('Não esperado'); }
  });
  assert.deepEqual(sent, [['101'], ['102']]);
});

test('recusa tamanho desconhecido ou fatura individual acima do limite sem barrar as outras', async () => {
  const errors = [];
  const sent = [];
  const outcome = await streamJointBillingInvoices([
    { id: '101' }, { id: '102' }, { id: '103' }
  ], {
    prepare: async ({ id }) => ({ 101: 1, 102: 0, 103: MAX_JOINT_ATTACHMENT_BYTES + 1 })[id],
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    },
    onPrepareError: async ({ id }) => errors.push(id)
  });
  assert.deepEqual(sent, [['101']]);
  assert.deepEqual(errors, ['102', '103']);
  assert.equal(outcome.errors, 2);
});

test('envia o grupo assim que o próximo anexo ultrapassaria 18 MB, sem esperar todas as faturas', async () => {
  const mb = 1024 * 1024;
  const sent = [];
  const outcome = await streamJointBillingInvoices([
    { id: '101' }, { id: '102' }, { id: '103' }
  ], {
    prepare: async ({ id }) => ({ 101: 10, 102: 9, 103: 2 })[id] * mb,
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    },
    onPrepareError: async () => { throw new Error('Não esperado'); }
  });
  assert.deepEqual(sent, [['101'], ['102', '103']]);
  assert.deepEqual(outcome, { sentBatches: 2, sentInvoices: 3, errors: 0, review: false });
});

test('erro em uma fatura não impede o envio das demais; resultado incerto interrompe grupos futuros', async () => {
  const sent = [];
  const errors = [];
  const outcome = await streamJointBillingInvoices([
    { id: '101' }, { id: '102' }, { id: '103' }, { id: '104' }
  ], {
    prepare: async ({ id }) => {
      if (id === '102') throw new Error('Brudam indisponível');
      return MAX_JOINT_ATTACHMENT_BYTES;
    },
    onPrepareError: async ({ id }) => errors.push(id),
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: sent.length === 2 ? 'review' : 'submitted' };
    }
  });
  assert.deepEqual(sent, [['101'], ['103']]);
  assert.deepEqual(errors, ['102']);
  assert.deepEqual(outcome, { sentBatches: 2, sentInvoices: 2, errors: 1, review: true });
});

test('grupo pendente é enviado após cinco minutos de preparação, mesmo abaixo de 18 MB', async () => {
  let clock = 0;
  const sent = [];
  await streamJointBillingInvoices([{ id: '101' }, { id: '102' }], {
    concurrency: 1,
    now: () => clock,
    prepare: async ({ id }) => {
      if (id === '102') clock = MAX_BATCH_WAIT_MS + 1;
      return 100;
    },
    onPrepareError: async () => { throw new Error('Não esperado'); },
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    }
  });
  assert.deepEqual(sent, [['101'], ['102']]);
});

test('grupo pronto também é enviado após demora causada por faturas com erro', async () => {
  let clock = 0;
  const sent = [];
  const outcome = await streamJointBillingInvoices([{ id: '101' }, { id: '102' }], {
    concurrency: 1,
    now: () => clock,
    prepare: async ({ id }) => {
      if (id === '102') {
        clock = MAX_BATCH_WAIT_MS + 1;
        throw new Error('Falha de consulta');
      }
      return 100;
    },
    onPrepareError: async () => {},
    wait: async () => {},
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    }
  });
  assert.deepEqual(sent, [['101']]);
  assert.equal(outcome.errors, 1);
});

test('fatura sem confirmação fica em espera enquanto as aptas são enviadas e só ela é refeita', async () => {
  const attempts = new Map();
  const sent = [];
  const delays = [];
  const outcome = await streamJointBillingInvoices([
    { id: '101' }, { id: '102' }, { id: '103' }
  ], {
    prepare: async ({ id }) => {
      attempts.set(id, (attempts.get(id) || 0) + 1);
      if (id === '102' && attempts.get(id) === 1) {
        throw Object.assign(new Error('Brudam limitou a consulta'), { status: 429 });
      }
      return id === '101' ? MAX_JOINT_ATTACHMENT_BYTES : 100;
    },
    onPrepareError: async () => {},
    wait: async (ms) => delays.push(ms),
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    }
  });
  assert.deepEqual(sent, [['101'], ['103'], ['102']]);
  assert.deepEqual(Object.fromEntries(attempts), { 101: 1, 102: 2, 103: 1 });
  assert.deepEqual(delays, [5000]);
  assert.deepEqual(outcome, { sentBatches: 3, sentInvoices: 3, errors: 0, review: false });
});

test('encerra a espera após três tentativas sem reenviar faturas já aceitas', async () => {
  let failedAttempts = 0;
  const sent = [];
  const delays = [];
  const outcome = await streamJointBillingInvoices([{ id: '101' }, { id: '102' }], {
    prepare: async ({ id }) => {
      if (id === '102') {
        failedAttempts += 1;
        throw Object.assign(new Error('Brudam HTTP 429'), { status: 429 });
      }
      return 100;
    },
    onPrepareError: async () => {},
    wait: async (ms) => delays.push(ms),
    send: async (batch) => {
      sent.push(batch.map(({ id }) => id));
      return { status: 'submitted' };
    }
  });
  assert.equal(failedAttempts, 3);
  assert.deepEqual(delays, [5000, 10000]);
  assert.deepEqual(sent, [['101']]);
  assert.deepEqual(outcome, { sentBatches: 1, sentInvoices: 1, errors: 1, review: false });
});

test('só reconsulta automaticamente uma prova próxima de expirar', () => {
  const now = Date.now();
  const proof = (age) => `${Buffer.from(JSON.stringify({ checkedAt: now - age }))
    .toString('base64url')}.assinatura`;
  assert.equal(jointProofNeedsRefresh(proof(21 * 60 * 1000), now), false);
  assert.equal(jointProofNeedsRefresh(proof(22 * 60 * 1000), now), true);
  assert.equal(jointProofNeedsRefresh('invalida', now), true);
});
