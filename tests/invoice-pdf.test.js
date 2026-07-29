const test = require('node:test');
const assert = require('node:assert/strict');
const {
  exactInvoiceRecord,
  companyFromPayload,
  normalizedCompany,
  linkedDocumentsFromInvoice,
  shipmentFromDetail,
  buildInvoicePdf
} = require('../server/faturamento/invoice-pdf');

test('não confunde o número público da fatura com o ID interno do lançamento', () => {
  const invoices = [
    { id: 11490, fatura: 9000 },
    { id: 20822, fatura: 11490 }
  ];
  assert.equal(exactInvoiceRecord(invoices, 11490).id, 20822);
  assert.equal(exactInvoiceRecord([{ id: 11490 }], 11490).id, 11490);
});

test('seleciona e normaliza o cadastro exato do cliente para o PDF', () => {
  const payload = {
    status: 1,
    data: [
      { cnpj: '00000000000000', fantasia: 'Outra' },
      {
        cnpj: '04.004.335/0001-39',
        razao: 'KRALIK DESPACHANTES ADUANEIROS',
        endereco: 'RUA CALDAS JUNIOR',
        numero: '20',
        bairro: 'CENTRO HISTORICO',
        cidade: 'PORTO ALEGRE',
        uf: 'RS',
        cep: '90010260',
        telefone: '5130280531'
      }
    ]
  };
  const company = companyFromPayload(payload, '04004335000139');
  assert.equal(company.razao, 'KRALIK DESPACHANTES ADUANEIROS');
  assert.deepEqual(normalizedCompany(company), {
    name: 'KRALIK DESPACHANTES ADUANEIROS',
    tradeName: '',
    document: '04.004.335/0001-39',
    stateRegistration: '',
    phone: '5130280531',
    address: 'RUA CALDAS JUNIOR, 20',
    district: 'CENTRO HISTORICO',
    city: 'PORTO ALEGRE',
    state: 'RS',
    cep: '90010-260'
  });
});

test('usa somente os documentos realmente vinculados à fatura', () => {
  const documents = linkedDocumentsFromInvoice({
    documentos: [
      { id: 24847, numero: '15097-0', tipo: 'CTE', valor: 677.10 }
    ]
  });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, 24847);
  assert.deepEqual(linkedDocumentsFromInvoice({}), []);
});

test('normaliza uma minuta detalhada para a linha da fatura', () => {
  const shipment = shipmentFromDetail(
    { id: 24847, numero: '15097-0', tipo: 'CTE', valor: 677.10 },
    {
      minuta: {
        id: 24847,
        xDocCTe: '15097-0',
        dEmi: '2026-07-10',
        cAut: '7666',
        cServ: 'DEDICADO NR',
        carga: { pBru: 7.48, pCub: 6, qVol: 1 }
      },
      compl: { xObs: '' },
      rem: { xFant: 'TECA POA', nDoc: '11111111000111' },
      dest: { xFant: 'NEUGEBAUER', nDoc: '22222222000122' },
      valores: { vFrete: 677.10 },
      documentos: [{ nDoc: '311855', dEmi: '2026-07-10', vNF: 17477.01, qVol: 1 }]
    },
    {
      origin: { cnpj: '11111111000111', fantasia: 'TECA POA', cidade: 'PORTO ALEGRE', uf: 'RS' },
      destination: { cnpj: '22222222000122', fantasia: 'NEUGEBAUER', cidade: 'ARROIO DO MEIO', uf: 'RS' }
    }
  );
  assert.equal(shipment.minute, '24847');
  assert.equal(shipment.cte, '15097-0');
  assert.equal(shipment.note, '311855');
  assert.equal(shipment.noteValue, 17477.01);
  assert.equal(shipment.destinationState, 'RS');
  assert.equal(shipment.taxedWeight, 7.48);
  assert.equal(shipment.freight, 677.10);
});

test('gera um PDF A4 com detalhe e resumo da fatura', async () => {
  const pdf = await buildInvoicePdf({
    invoice: {
      id: 11490,
      issuedAt: '2026-07-10',
      dueAt: '2026-07-24',
      total: 677.10,
      surcharge: 0,
      discount: 0,
      nfs: ''
    },
    client: {
      name: 'KRALIK DESPACHANTES ADUANEIROS',
      tradeName: '',
      document: '04004335000139',
      stateRegistration: '',
      phone: '(51) 3028-0531',
      address: 'RUA CALDAS JUNIOR, 20',
      district: 'CENTRO HISTORICO',
      city: 'PORTO ALEGRE',
      state: 'RS',
      cep: '90010-260'
    },
    shipments: [{
      minute: '24847',
      cte: '15097-0',
      collection: '7666',
      date: '10/07/2026',
      note: '311855',
      noteValue: 17477.01,
      authorization: '-',
      origin: 'TECA POA\nPORTO ALEGRE, RS',
      destination: 'NEUGEBAUER\nARROIO DO MEIO, RS',
      destinationState: 'RS',
      taxedWeight: 7.48,
      volumes: 1,
      freight: 677.10,
      observation: '',
      service: 'DEDICADO NR'
    }],
    detailAvailable: true
  });
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.length > 5000);
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2);
});
