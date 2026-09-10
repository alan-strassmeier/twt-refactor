const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatDigitableLine,
  ourNumberDigit,
  formatOurNumber,
  formatBeneficiaryAccount,
  renderBradescoBankSlipPdf
} = require('../server/faturamento/bradesco-boleto-pdf');

const record = {
  invoiceId: '11777',
  bank: 'bradesco',
  bankSlipId: '00000021311',
  beneficiaryName: 'TWT AIRPACK SERVICOS AUX. DE TRANSP. AEREO LTDA',
  beneficiaryTaxId: '09123137000108',
  agency: '7218',
  agencyDigit: '4',
  account: '0000074',
  accountDigit: '4',
  wallet: '09',
  ourNumber: '00000021311',
  yourNumber: 'FAT11777',
  amount: 724.61,
  issuedAt: '2026-09-10',
  dueAt: '2026-09-24',
  createdAt: '2026-09-10T12:00:00.000Z',
  acceptance: 'N',
  speciesLabel: 'DS',
  digitableLine: '23797218029000000213011000007408715790000072461',
  barCode: '23797157900000724617218090000002131100000740',
  instructions: [
    'Referente a fatura 11777.',
    'Apos o vencimento multa de 3,00%.',
    'Apos o vencimento juros de 0,15% ao dia.'
  ].join('\n'),
  payer: {
    name: 'INGA EXPRESS TRANSPORTE E LOGISTICA LTDA',
    tax_id: '07843144000159',
    address: {
      street: 'RUA EXEMPLO',
      number: 237,
      complement: 'SALA 4',
      district: 'CENTRO',
      city: 'PORTO ALEGRE',
      state: 'RS',
      zip_code: '90000000'
    }
  }
};

test('formata os identificadores Bradesco do boleto real', () => {
  assert.equal(ourNumberDigit('09', '00000021311'), '2');
  assert.equal(formatOurNumber(record), '09/00000021311-2');
  assert.equal(formatBeneficiaryAccount(record), '7218-4 / 0000074-4');
  assert.equal(
    formatDigitableLine(record.digitableLine),
    '23797.21802 90000.002130 11000.007408 7 15790000072461'
  );
});

test('gera boleto Bradesco A4 com linha digitável e código de barras', async () => {
  const pdf = await renderBradescoBankSlipPdf(record);
  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
  assert.equal(pdf.length > 4000, true);
});

test('recusa gerar PDF Bradesco quando os códigos estão incompletos', async () => {
  await assert.rejects(
    renderBradescoBankSlipPdf({ ...record, digitableLine: '2379' }),
    (error) => error.statusCode === 502 && error.expose === true
  );
});
