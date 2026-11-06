const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EVENT_TYPES, freightNoticeApplies, freightNoticeText,
  billingText, billingHtml, jointBillingText, jointBillingHtml
} = require('../server/faturamento/cobranca-email');
const noticeConfig = require('../server/faturamento/cobranca-aviso.json');

const before = new Date('2026-11-06T02:59:59Z'); // 05/11 em São Paulo
const after = new Date('2026-11-06T03:00:00Z'); // 06/11 em São Paulo
const invoice = (name) => ({
  client: { tradeName: name, name: 'Outra razão social', document: '35820448006339' },
  invoice: { id: '123', dueAt: '2026-11-10', total: 100, payment: { type: 'ted_doc' } }
});
const contact = { firstName: 'Ana' };
const joint = (companyName) => ({ companyName, invoices: [{ id: '123', overdueDays: 2 }],
  paymentMethod: 'TED/DOC', totalBalance: 100 });

test('aviso respeita o início em 06/11/2026 no horário de São Paulo e os nomes-alvo', () => {
  for (const name of ['SPS White Martins', 'White Martis', 'BL', 'BL Transportes', 'Verallia Brasil']) {
    assert.equal(freightNoticeApplies(name, before), false, name);
    assert.equal(freightNoticeApplies(name, after), true, name);
  }
  for (const name of ['Empresa Exemplo', 'Blumenau Transportes', 'PUBLICA LTDA']) {
    assert.equal(freightNoticeApplies(name, after), false, name);
  }
});

test('configuração permite desligar o aviso e editar empresas sem mudar os modelos', () => {
  assert.equal(freightNoticeApplies('White Martins', after, { ...noticeConfig, enabled: false }), false);
  const custom = { ...noticeConfig, companyNameContains: ['Empresa Nova'], companyNameWords: [] };
  assert.equal(freightNoticeApplies('White Martins', after, custom), false);
  assert.equal(freightNoticeApplies('Empresa Nova Ltda', after, custom), true);
});

test('cobranças individuais incluem o comunicado em texto e HTML para todos os eventos', () => {
  for (const event of Object.values(EVENT_TYPES)) {
    const text = billingText(event, invoice('White Martins'), contact, after);
    const html = billingHtml(event, invoice('White Martins'), contact, after);
    assert.match(text, /COMUNICADO — PRAZO DE PAGAMENTO DE FRETES/);
    assert.match(text, /\*30 \(trinta\) dias corridos\*/);
    assert.match(html, /<strong>30 \(trinta\) dias úteis<\/strong>/);
    assert.equal(text.split('COMUNICADO — PRAZO DE PAGAMENTO DE FRETES').length, 2);
    assert.doesNotMatch(billingText(event, invoice('White Martins'), contact, before), /COMUNICADO/);
    assert.doesNotMatch(billingHtml(event, invoice('Outra empresa'), contact, after), /COMUNICADO/);
  }
  assert.match(freightNoticeText, /Comunicado Geral SUROC nº 1\/2026/);
});

test('cobrança conjunta inclui o comunicado apenas para empresas-alvo após a data', () => {
  assert.match(jointBillingText(joint('Verallia'), after), /COMUNICADO/);
  assert.match(jointBillingHtml(joint('BL'), after), /COMUNICADO/);
  assert.match(jointBillingText({ ...joint('Ana'), targetCompanyName: 'White Martins' }, after), /COMUNICADO/);
  assert.doesNotMatch(jointBillingText(joint('Verallia'), before), /COMUNICADO/);
  assert.doesNotMatch(jointBillingHtml(joint('Outra empresa'), after), /COMUNICADO/);
});
