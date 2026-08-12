const test = require('node:test');
const assert = require('node:assert/strict');
const PDFDocument = require('pdfkit');
const {
  issuerDisplayName,
  displayAuthorization,
  TABLE_COLUMN_GEOMETRY,
  shipmentLayout,
  exactInvoiceRecord,
  companyFromPayload,
  normalizedCompany,
  linkedDocumentsFromInvoice,
  linkedDocumentsFromDoccob,
  detailIdentifiers,
  fetchMinuteDetailsForNote,
  resolveDoccobTransportDetail,
  shipmentFromDetail,
  buildInvoicePdf
} = require('../server/faturamento/invoice-pdf');

test('abrevia o nome da TWT sem alterar os demais emitentes', () => {
  assert.equal(issuerDisplayName({
    document: '09.123.137/0001-08',
    name: 'TWT AIRPACK SERVICOS AUXILIARES DE TRANSPORTE AEREO LTDA ME'
  }), 'TWT AIRPACK SERVICOS AUX. DE TRANSP. AEREO LTDA');
  assert.equal(issuerDisplayName({
    document: '97.434.690/0001-29',
    name: 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA'
  }), 'DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA');
});

test('não exibe uma chave longa no campo de autorização', () => {
  assert.equal(displayAuthorization('7666'), '7666');
  assert.equal(displayAuthorization('43260797434690000129570000000151221704715130'), '-');
});

test('mantém os totais exatamente sob as colunas solicitadas', () => {
  assert.equal(TABLE_COLUMN_GEOMETRY.collection.x, 85);
  assert.equal(TABLE_COLUMN_GEOMETRY.date.x, 115);
  assert.equal(TABLE_COLUMN_GEOMETRY.noteValue.x, 198);
  assert.equal(TABLE_COLUMN_GEOMETRY.taxedWeight.x, 471);
  assert.equal(TABLE_COLUMN_GEOMETRY.volumes.x, 505);
  assert.equal(TABLE_COLUMN_GEOMETRY.freight.x, 539);
});

test('aumenta a linha para preservar observações longas', () => {
  const doc = new PDFDocument({ autoFirstPage: false });
  const shortLayout = shipmentLayout(doc, {
    origin: 'PORTO ALEGRE, RS',
    destination: 'SAO PAULO, SP',
    observation: 'CLIENTE RETIRA NA BASE.'
  });
  const longLayout = shipmentLayout(doc, {
    origin: 'PORTO ALEGRE, RS',
    destination: 'SAO PAULO, SP',
    observation: 'ENTREGA SOMENTE MEDIANTE AGENDAMENTO. '.repeat(35)
  });
  assert.ok(longLayout.observationHeight > shortLayout.observationHeight);
  assert.equal(longLayout.totalHeight, longLayout.mainHeight + longLayout.observationHeight);
  doc.end();
});

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

test('não trata o ID interno ou o número do CT-e como ID da minuta', () => {
  assert.deepEqual(detailIdentifiers({
    id: '66262',
    numero: '6135-2',
    tipo: 'CTE'
  }), []);

  assert.deepEqual(detailIdentifiers({
    id: '66262',
    numero: '6135-2',
    tipo: 'CTE',
    chave: '43260797434690000129570000000151131927245991',
    id_minuta: '24437'
  }), ['43260797434690000129570000000151131927245991', '24437']);
});

test('transforma cada vínculo DOCCOB em um documento seguro para consulta', () => {
  const documents = linkedDocumentsFromDoccob({
    transports: [{
      reference: '24783',
      minuteHint: '24783',
      cteNumber: null,
      accessKey: null,
      freight: 47,
      notes: [{ number: '317063', partyCnpj: '00280273001028' }]
    }]
  });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].tipo, 'MINUTA');
  assert.equal(documents[0].id_minuta, '24783');
  assert.equal(documents[0].numero, null);
  assert.deepEqual(detailIdentifiers(documents[0]), ['24783']);
});

test('resolve um vínculo sem chave diretamente pelo número da minuta', async () => {
  const calls = [];
  const detail = {
    minuta: { id: 24766 },
    documentos: []
  };
  const get = async (path) => {
    calls.push(path);
    return {
      response: { ok: true, status: 200 },
      payload: { status: 1, data: [detail] }
    };
  };
  const result = await resolveDoccobTransportDetail({
    minuteHint: '24766',
    accessKey: null,
    notes: []
  }, get);
  assert.equal(result, detail);
  assert.deepEqual(calls, ['/operacional/consulta/minuta/24766']);
});

test('usa NF e CNPJ para encontrar a minuta quando não há chave nem número direto', async () => {
  const calls = [];
  const detail = {
    minuta: { id: 24891 },
    rem: { nDoc: '00280273001028' },
    documentos: [{ nDoc: '317063' }]
  };
  const get = async (path) => {
    calls.push(path);
    if (path.startsWith('/tracking/ocorrencias/cnpj/nf?')) {
      return {
        response: { ok: true, status: 200 },
        payload: {
          status: 1,
          data: [{ dados: [{ tipo: 'CTE', cte_numero: '15127-0' }] }]
        }
      };
    }
    if (path.startsWith('/operacional/custos?')) {
      return {
        response: { ok: true, status: 200 },
        payload: { status: 1, data: [{ id: 24891 }] }
      };
    }
    if (path === '/operacional/consulta/minuta/24891') {
      return {
        response: { ok: true, status: 200 },
        payload: { status: 1, data: [detail] }
      };
    }
    throw new Error(`Caminho inesperado: ${path}`);
  };

  const matches = await fetchMinuteDetailsForNote({
    number: '317063',
    partyCnpj: '00280273001028'
  }, get);
  assert.deepEqual(matches, [detail]);
  assert.equal(calls.length, 3);
});

test('tenta também o CNPJ do cliente e informa a emissão na consulta de custos', async () => {
  const calls = [];
  const detail = {
    minuta: { id: 24891 },
    rem: { nDoc: '00280273001028' },
    documentos: [{ nDoc: '317063' }]
  };
  const get = async (path) => {
    calls.push(path);
    if (path.startsWith('/tracking/ocorrencias/cnpj/nf?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      if (query.get('documento') === '28759933000186') {
        return {
          response: { ok: true, status: 200 },
          payload: { status: 1, data: [{ dados: [{ cte_numero: '15127-0' }] }] }
        };
      }
      return {
        response: { ok: false, status: 404 },
        payload: { status: 0 }
      };
    }
    if (path.startsWith('/operacional/custos?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      assert.equal(query.get('numero'), '15127');
      assert.equal(query.get('emissao[eq]'), '2026-06-26');
      return {
        response: { ok: true, status: 200 },
        payload: { status: 1, data: [{ id: 24891 }] }
      };
    }
    if (path === '/operacional/consulta/minuta/24891') {
      return {
        response: { ok: true, status: 200 },
        payload: { status: 1, data: [detail] }
      };
    }
    throw new Error(`Caminho inesperado: ${path}`);
  };

  const matches = await fetchMinuteDetailsForNote({
    number: '317063',
    partyCnpj: '00280273001028',
    transportIssuedAt: '2026-06-26'
  }, get, {
    clientCnpj: '28759933000186',
    transportIssuedAt: '2026-06-26'
  });
  assert.deepEqual(matches, [detail]);
  assert.equal(calls.length, 4);
});

test('não aceita uma minuta de NF pertencente a outro CNPJ', async () => {
  const get = async (path) => {
    if (path.startsWith('/tracking/ocorrencias/cnpj/nf?')) {
      return {
        response: { ok: true, status: 200 },
        payload: { status: 1, data: [{ dados: [{ tipo: 'Minuta', numero: 24891 }] }] }
      };
    }
    return {
      response: { ok: true, status: 200 },
      payload: {
        status: 1,
        data: [{
          minuta: { id: 24891 },
          rem: { nDoc: '11111111000111' },
          documentos: [{ nDoc: '317063' }]
        }]
      }
    };
  };
  const matches = await fetchMinuteDetailsForNote({
    number: '317063',
    partyCnpj: '00280273001028'
  }, get);
  assert.deepEqual(matches, []);
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

test('gera somente a página principal da fatura em PDF A4', async () => {
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
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
});
