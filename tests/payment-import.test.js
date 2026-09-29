const test = require('node:test');
const assert = require('node:assert/strict');
const {
  excelDate,
  parseReference,
  parsePaymentWorksheet
} = require('../server/faturamento/payment-import-xlsx');
const {
  isWhiteMartinsCategory,
  analyzePaymentImport,
  approveCandidate
} = require('../server/faturamento/payment-import');

test('leitor reconhece as colunas da planilha de pagamentos sem perder CNPJ e referência', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1">
          <c r="A1" t="inlineStr"><is><t>Nº ID fiscal 1</t></is></c>
          <c r="B1" t="inlineStr"><is><t>Nome 1</t></is></c>
          <c r="C1" t="inlineStr"><is><t>Fornecedor</t></is></c>
          <c r="D1" t="inlineStr"><is><t>Referência</t></is></c>
          <c r="E1" t="inlineStr"><is><t>Vencim.em</t></is></c>
          <c r="F1" t="inlineStr"><is><t>Montante em MI</t></is></c>
        </row>
        <row r="2">
          <c r="A2" t="inlineStr"><is><t>97434690000129</t></is></c>
          <c r="B2" t="inlineStr"><is><t>DSL</t></is></c>
          <c r="C2" t="inlineStr"><is><t>10021598</t></is></c>
          <c r="D2" t="inlineStr"><is><t>15005-0</t></is></c>
          <c r="E2"><v>46286</v></c>
          <c r="F2"><v>88.75</v></c>
        </row>
      </sheetData>
    </worksheet>`;
  const parsed = parsePaymentWorksheet(xml);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], {
    row: 2,
    supplierTaxId: '97434690000129',
    supplierName: 'DSL',
    vendor: '10021598',
    reference: '15005-0',
    cteNumber: '15005',
    dueAt: '2026-09-21',
    amount: 88.75
  });
  assert.equal(excelDate(46286), '2026-09-21');
  assert.deepEqual(parseReference('001505-0'), { source: '001505-0', cteNumber: '1505' });
});

test('escopo da importação aceita apenas categoria identificada como White Martins', () => {
  assert.equal(isWhiteMartinsCategory({ cnpj: '35820448009516', name: 'BAU WHITE MARTINS GASES' }), true);
  assert.equal(isWhiteMartinsCategory({ cnpj: '30455661001900', name: 'ELECNOR DO BRASIL' }), false);
});

test('análise vincula CT-e, DOCCOB e fatura aberta somente quando o valor fecha', async () => {
  let saved;
  const record = await analyzePaymentImport({
    filename: 'pagamentos.xlsx',
    fileBase64: 'ignorado',
    paymentDate: '2026-09-29',
    paymentMethodId: '3',
    bankAccountId: '17'
  }, {
    parseXlsx: () => ({
      rows: [{
        row: 2,
        supplierTaxId: '97434690000129',
        reference: '15342-0',
        cteNumber: '15342',
        dueAt: '2026-10-13',
        amount: 1385.65
      }],
      errors: []
    }),
    listCategories: async () => [{ cnpj: '41870054000276', name: 'White Martins Cariacica' }],
    findMatches: async () => [{
      reference: '15342',
      invoiceId: '11840',
      clientCnpj: '41870054000276',
      invoice: { issuerCnpj: '97434690000129', dueAt: '2026-10-13' },
      transportReferences: ['15342']
    }],
    fetchInvoices: async () => ({ invoices: [{
      id: '11840',
      internalId: 84583298,
      client: 'White Martins Cariacica',
      clientDocument: '41870054000276',
      dueAt: '2026-10-13',
      total: 1385.65,
      balance: 1385.65,
      status: 0
    }] }),
    saveImport: async (value) => { saved = value; }
  });
  assert.equal(record.summary.eligibleInvoices, 1);
  assert.equal(record.candidates[0].invoiceId, '11840');
  assert.equal(record.candidates[0].eligible, true);
  assert.equal(saved.id, record.id);
});

test('aprovação reconfere a fatura e envia o contrato oficial de liquidação à Brudam', async () => {
  const calls = { completed: [], released: 0, removed: 0 };
  const result = await approveCandidate({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    scope: { cnpjs: ['41870054000276'] },
    settings: { paymentDate: '2026-09-29', paymentMethodId: 3, bankAccountId: 17 }
  }, {
    invoiceId: '11840',
    clientCnpj: '41870054000276',
    importedAmount: 1385.65
  }, {
    claimApproval: async () => true,
    releaseApproval: async () => { calls.released += 1; },
    fetchInvoices: async () => ({ invoices: [{
      id: '11840', internalId: 84583298, clientDocument: '41870054000276',
      balance: 1385.65, status: 0
    }] }),
    liquidate: async (path, body) => {
      calls.path = path;
      calls.body = body;
      return {
        response: { ok: true, status: 200 },
        payload: { status: 1, data: { status: 1, ids: [84583298] } }
      };
    },
    removePending: async () => { calls.removed += 1; },
    markCompleted: async (event) => { calls.completed.push(event); }
  });
  assert.equal(result.status, 'liquidated');
  assert.equal(calls.path, '/financeiro/liquidar/lancamento');
  assert.deepEqual(calls.body, {
    documentos: [{
      id_lancamento: 84583298,
      data_pagamento: '2026-09-29',
      forma_pagamento: 3,
      data_credito_debito: '2026-09-29',
      valor_juros: 0,
      valor_liquidado: 1385.65,
      conta_bancaria: 17
    }]
  });
  assert.equal(calls.removed, 1);
  assert.deepEqual(calls.completed.sort(), ['initial', 'overdue', 'reminder']);
  assert.equal(calls.released, 1);
});

test('aprovação nunca envia liquidação quando a fatura já está liquidada', async () => {
  let liquidations = 0;
  const result = await approveCandidate({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    scope: { cnpjs: ['41870054000276'] },
    settings: { paymentDate: '2026-09-29', paymentMethodId: 3, bankAccountId: 17 }
  }, {
    invoiceId: '11840', clientCnpj: '41870054000276', importedAmount: 1385.65
  }, {
    claimApproval: async () => true,
    releaseApproval: async () => {},
    fetchInvoices: async () => ({ invoices: [{
      id: '11840', internalId: 84583298, clientDocument: '41870054000276',
      balance: 0, status: 1
    }] }),
    liquidate: async () => { liquidations += 1; },
    removePending: async () => {},
    markCompleted: async () => {}
  });
  assert.equal(result.status, 'already_settled');
  assert.equal(liquidations, 0);
});
