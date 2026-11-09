const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { mergeBillingAttachments, sendBillingEmail, sendJointBillingEmail,
  EVENT_TYPES } = require('../server/faturamento/cobranca-email');

const pdf = async (width) => {
  const document = await PDFDocument.create();
  document.addPage([width, 200]);
  return Buffer.from(await document.save());
};
const part = (filename, content) => ({ filename, content, contentType: 'application/pdf' });

test('unifica fatura, DACTE, nota e boleto mantendo a ordem das páginas', async () => {
  const attachments = await mergeBillingAttachments([
    part('fatura.pdf', await pdf(101)), part('dacte.pdf', await pdf(102)),
    part('nota.pdf', await pdf(103)), part('boleto.pdf', await pdf(104))
  ], 'documentos.pdf');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, 'documentos.pdf');
  const result = await PDFDocument.load(attachments[0].content);
  assert.deepEqual(result.getPages().map((page) => page.getWidth()), [101, 102, 103, 104]);
});

test('não envia PDF inválido e não mexe no único PDF existente', async () => {
  await assert.rejects(mergeBillingAttachments([
    part('fatura.pdf', await pdf(101)), part('dacte.pdf', Buffer.from('inválido'))
  ], 'documentos.pdf'), /dacte\.pdf/);
  const original = await pdf(101);
  const result = await mergeBillingAttachments([part('fatura.pdf', original)], 'documentos.pdf');
  assert.equal(result[0].content, original);
});

test('envio individual preserva PDFs separados ao SMTP', async () => {
  let sent;
  await sendBillingEmail({
    event: EVENT_TYPES.initial,
    data: { client: { tradeName: 'Empresa', document: '12345678000190' },
      invoice: { id: '101', dueAt: '2026-11-10', total: 100, payment: { type: 'ted_doc' } } },
    contact: { firstName: 'Ana', email: 'ana@example.com' },
    invoicePdf: await pdf(101), dactePdf: await pdf(102), nfsePdf: await pdf(103),
    transport: { sendMail: async (message) => { sent = message; return { accepted: ['ana@example.com'] }; } },
    config: { fromName: 'TWT', fromEmail: 'faturamento@twt.com.br' }
  });
  assert.deepEqual(sent.attachments.map(({ filename }) => filename), [
    'fatura-101.pdf', 'dactes-fatura-101.pdf', 'nota-fiscal-fatura-101.pdf'
  ]);
  assert.deepEqual(await Promise.all(sent.attachments.map(async ({ content }) =>
    (await PDFDocument.load(content)).getPageCount())), [1, 1, 1]);
});

test('envio conjunto entrega um único PDF com as faturas na sequência', async () => {
  let sent;
  await sendJointBillingEmail({
    recipients: [{ firstName: 'Ana', email: 'ana@example.com' }],
    companyName: 'Empresa', invoices: [{ id: '101', overdueDays: 2 }, { id: '102', overdueDays: 1 }],
    paymentMethod: 'TED/DOC', totalBalance: 200, clientReference: 'test-ref',
    attachments: [part('fatura-101.pdf', await pdf(101)), part('dacte-101.pdf', await pdf(102)),
      part('fatura-102.pdf', await pdf(103)), part('dacte-102.pdf', await pdf(104))],
    transport: { sendMail: async (message) => { sent = message; return { accepted: ['ana@example.com'] }; } },
    config: { fromName: 'TWT', fromEmail: 'faturamento@twt.com.br', alertEmail: 'interno@example.com' }
  });
  assert.equal(sent.attachments.length, 1);
  const result = await PDFDocument.load(sent.attachments[0].content);
  assert.deepEqual(result.getPages().map((page) => page.getWidth()), [101, 102, 103, 104]);
});
