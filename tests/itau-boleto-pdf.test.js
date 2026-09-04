const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatBeneficiaryAccount,
  formatDigitableLine,
  payerAddress,
  renderItauBankSlipPdf
} = require('../server/faturamento/itau-boleto-pdf');

const record = {
  invoiceId: '11532',
  bank: 'itau',
  bankSlipId: 'b1ff5cc0-8a9c-497e-b983-738904c23386',
  beneficiaryId: '150000052061',
  beneficiaryName: 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA',
  beneficiaryTaxId: '97434690000129',
  wallet: '109',
  ourNumber: '00011532',
  yourNumber: 'FAT11532',
  amount: 501.87,
  issuedAt: '2026-08-12',
  dueAt: '2026-10-12',
  createdAt: '2026-09-04T12:00:00.000Z',
  acceptance: 'N',
  speciesLabel: 'DS',
  digitableLine: '34191234567890123456789012345678901234567890123',
  barCode: '34191234567890123456789012345678901234567890',
  payer: {
    name: 'DIADEMA WHITE MARTINS GASES INDUSTRIAIS LTDA',
    tax_id: '35820448008110',
    address: {
      street: 'AVENIDA PIRAPORINHA',
      number: 1000,
      complement: 'GALPAO 2',
      district: 'CENTRO',
      city: 'DIADEMA',
      state: 'SP',
      zip_code: '09950000'
    }
  }
};

test('formata conta do beneficiário e endereço do pagador', () => {
  assert.equal(formatBeneficiaryAccount('150000052061'), '1500 / 0005206-1');
  assert.equal(
    formatDigitableLine(record.digitableLine),
    '34191.23456 78901.234567 89012.345678 9 01234567890123'
  );
  assert.match(payerAddress(record.payer), /AVENIDA PIRAPORINHA, 1000, GALPAO 2/);
  assert.match(payerAddress(record.payer), /DIADEMA - SP/);
});

test('gera boleto Itaú A4 com linha digitável e código de barras', async () => {
  const pdf = await renderItauBankSlipPdf(record);
  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
  assert.equal(pdf.length > 4000, true);
});

test('recusa gerar PDF quando os códigos bancários estão incompletos', async () => {
  await assert.rejects(
    renderItauBankSlipPdf({ ...record, barCode: '3419' }),
    (error) => error.statusCode === 502 && error.expose === true
  );
});
