const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidCteAccessKey,
  parseDoccob
} = require('../server/faturamento/doccob');
const {
  r2ConfigFromEnv,
  findDoccobForInvoice
} = require('../server/faturamento/r2-doccob');

const record = (length, values) => {
  const fields = Array.from({ length }, () => '');
  Object.entries(values).forEach(([index, value]) => {
    fields[Number(index)] = String(value);
  });
  return fields.join('~');
};

const invoiceRecord = ({ invoice, issuedAt, dueAt, client, issuer, total }) =>
  record(33, {
    0: 4,
    1: issuer,
    5: invoice,
    7: client,
    11: issuedAt,
    12: dueAt,
    13: total
  });

const transportRecord = ({ reference, issuedAt, client, issuer, freight, weight, volumes, key = '' }) =>
  record(78, {
    0: 1,
    1: 'FREIGHT',
    2: 'CTE',
    6: reference,
    7: 0,
    8: issuedAt,
    12: issuer,
    18: client,
    26: freight,
    53: volumes,
    57: weight,
    69: key,
    70: key ? 'AUTORIZADO O USO DO CT-E' : 'FINALIZADA'
  });

const invoiceLink = ({ invoice, invoiceDate, client, reference, transportDate }) =>
  record(16, {
    0: 3,
    1: 'FT_CTR',
    6: invoice,
    7: invoiceDate,
    8: client,
    12: reference,
    13: transportDate
  });

const noteLink = ({ reference, transportDate, party, series, number, issuedAt }) =>
  record(16, {
    0: 3,
    1: 'CTR_NF',
    6: reference,
    7: transportDate,
    8: party,
    11: series,
    12: number,
    13: issuedAt
  });

const CTE_KEY_15122 = '43260797434690000129570000000151221704715130';
const CTE_KEY_15127 = '43260797434690000129570000000151271173858705';

const cteDoccob = [
  record(4, { 0: 0, 1: '07/08/2026 17:07:47', 2: '1.1' }),
  invoiceRecord({
    invoice: 11532,
    issuedAt: '20072026',
    dueAt: '04082026',
    client: '41870054000276',
    issuer: '97434690000129',
    total: '000000006837,18'
  }),
  transportRecord({
    reference: 15122,
    issuedAt: '16072026',
    client: '41870054000276',
    issuer: '97434690000129',
    freight: '0000000000002272,90',
    weight: '0000000130,5000',
    volumes: '00001400',
    key: CTE_KEY_15122
  }),
  invoiceLink({
    invoice: 11532,
    invoiceDate: '20072026',
    client: '41870054000276',
    reference: 15122,
    transportDate: '16072026'
  }),
  noteLink({
    reference: 15122,
    transportDate: '16072026',
    party: '41870054000276',
    series: 1,
    number: 1776,
    issuedAt: '14072026'
  }),
  transportRecord({
    reference: 15127,
    issuedAt: '17072026',
    client: '41870054000276',
    issuer: '97434690000129',
    freight: '0000000000004564,28',
    weight: '0000000304,4800',
    volumes: '00003700',
    key: CTE_KEY_15127
  }),
  invoiceLink({
    invoice: 11532,
    invoiceDate: '20072026',
    client: '41870054000276',
    reference: 15127,
    transportDate: '17072026'
  }),
  noteLink({
    reference: 15127,
    transportDate: '17072026',
    party: '41870054000276',
    series: 1,
    number: 1782,
    issuedAt: '16072026'
  })
].join('\n');

const minuteDoccob = [
  invoiceRecord({
    invoice: 11518,
    issuedAt: '16072026',
    dueAt: '30072026',
    client: '28759933000186',
    issuer: '09123137000108',
    total: '000000000143,59'
  }),
  transportRecord({
    reference: 24766,
    issuedAt: '24062026',
    client: '28759933000186',
    issuer: '09123137000108',
    freight: '0000000000000096,59',
    weight: '0000000115,5000',
    volumes: '00000500'
  }),
  invoiceLink({
    invoice: 11518,
    invoiceDate: '16072026',
    client: '28759933000186',
    reference: 24766,
    transportDate: '24062026'
  }),
  transportRecord({
    reference: 24783,
    issuedAt: '26062026',
    client: '28759933000186',
    issuer: '09123137000108',
    freight: '0000000000000047,00',
    weight: '0000000005,1000',
    volumes: '00000100'
  }),
  invoiceLink({
    invoice: 11518,
    invoiceDate: '16072026',
    client: '28759933000186',
    reference: 24783,
    transportDate: '26062026'
  }),
  noteLink({
    reference: 24783,
    transportDate: '26062026',
    party: '00280273001028',
    series: 4,
    number: 317063,
    issuedAt: '19062026'
  }),
  noteLink({
    reference: 24783,
    transportDate: '26062026',
    party: '00280273001028',
    series: 1,
    number: 19903,
    issuedAt: '22062026'
  })
].join('\n');

test('valida as chaves CT-e de 44 dígitos recebidas no DOCCOB', () => {
  assert.equal(isValidCteAccessKey(CTE_KEY_15122), true);
  assert.equal(isValidCteAccessKey(CTE_KEY_15127), true);
  assert.equal(isValidCteAccessKey(`${CTE_KEY_15127.slice(0, 43)}9`), false);
});

test('interpreta uma fatura DOCCOB com dois CT-es autorizados', () => {
  const parsed = parseDoccob(cteDoccob, 11532);
  assert.deepEqual(parsed.invoice, {
    id: '11532',
    issuedAt: '2026-07-20',
    dueAt: '2026-08-04',
    clientCnpj: '41870054000276',
    issuerCnpj: '97434690000129',
    total: 6837.18
  });
  assert.equal(parsed.transports.length, 2);
  assert.equal(parsed.transports[0].cteNumber, '15122-0');
  assert.equal(parsed.transports[0].accessKey, CTE_KEY_15122);
  assert.equal(parsed.transports[0].minuteHint, null);
  assert.equal(parsed.transports[0].taxedWeight, 130.5);
  assert.equal(parsed.transports[0].volumes, 14);
  assert.equal(parsed.transports[0].notes[0].number, '1776');
  assert.equal(parsed.transports[1].freight, 4564.28);
});

test('interpreta remessas sem chave como minutas e preserva NF mais CNPJ', () => {
  const parsed = parseDoccob(minuteDoccob, 11518);
  assert.equal(parsed.transports.length, 2);
  assert.equal(parsed.transports[0].minuteHint, '24766');
  assert.equal(parsed.transports[0].cteNumber, null);
  assert.deepEqual(parsed.transports[0].notes, []);
  assert.equal(parsed.transports[1].minuteHint, '24783');
  assert.deepEqual(parsed.transports[1].notes.map((note) => [note.number, note.partyCnpj]), [
    ['317063', '00280273001028'],
    ['19903', '00280273001028']
  ]);
});

test('localiza no R2 o DOCCOB que contém a fatura exata', async () => {
  const contents = {
    'brudam/clientes/41870054000276/doccob/mais-novo.txt': minuteDoccob,
    'brudam/clientes/41870054000276/doccob/correto.txt': cteDoccob
  };
  const storage = {
    async listObjects(prefix) {
      assert.equal(prefix, 'brudam/clientes/41870054000276/doccob/');
      return Object.keys(contents).map((Key, index) => ({
        Key,
        LastModified: new Date(2026, 7, 8 - index)
      }));
    },
    async getObject(key) {
      return contents[key];
    }
  };
  const result = await findDoccobForInvoice({
    invoiceId: 11532,
    clientCnpj: '41.870.054/0002-76',
    config: { basePrefix: 'brudam/clientes', scanLimit: 20 },
    storage
  });
  assert.equal(result.invoice.id, '11532');
  assert.equal(result.objectKey, 'brudam/clientes/41870054000276/doccob/correto.txt');
});

test('só habilita R2 quando todas as credenciais privadas existem', () => {
  assert.equal(r2ConfigFromEnv({}), null);
  assert.deepEqual(r2ConfigFromEnv({
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET_NAME: 'bucket'
  }), {
    accountId: 'account',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'bucket',
    basePrefix: 'brudam/clientes',
    scanLimit: 250
  });
});

module.exports = {
  cteDoccob,
  minuteDoccob
};
