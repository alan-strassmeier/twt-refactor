const test = require('node:test');
const assert = require('node:assert/strict');
const { splitJointBillingInvoices, MAX_JOINT_ATTACHMENT_BYTES } =
  require('../faturamento/cobranca-batches');

test('divide o envio em e-mails de até 18 MB sem separar os anexos de uma fatura', () => {
  const mb = 1024 * 1024;
  const batches = splitJointBillingInvoices([
    { id: '101', preparedBytes: 10 * mb },
    { id: '102', preparedBytes: 8 * mb },
    { id: '103', preparedBytes: 9 * mb },
    { id: '104', preparedBytes: 4 * mb }
  ]);
  assert.deepEqual(batches.map((batch) => batch.map(({ id }) => id)),
    [['101', '102'], ['103', '104']]);
  assert.ok(batches.every((batch) => batch.reduce((sum, invoice) =>
    sum + invoice.preparedBytes, 0) <= MAX_JOINT_ATTACHMENT_BYTES));
});

test('anexo individual exatamente no limite ocupa um e-mail próprio', () => {
  const batches = splitJointBillingInvoices([
    { id: '101', preparedBytes: MAX_JOINT_ATTACHMENT_BYTES },
    { id: '102', preparedBytes: 1 }
  ]);
  assert.deepEqual(batches.map((batch) => batch.map(({ id }) => id)), [['101'], ['102']]);
});

test('recusa tamanho desconhecido ou fatura individual acima do limite', () => {
  assert.throws(() => splitJointBillingInvoices([{ id: '101', preparedBytes: null }]),
    /não foi confirmado/);
  assert.throws(() => splitJointBillingInvoices([{ id: '101', preparedBytes: MAX_JOINT_ATTACHMENT_BYTES + 1 }]),
    /ultrapassam 18 MB sozinhos/);
});
