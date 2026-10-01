const { queryItauBankSlips, itauBoletoConfig } = require('./itau');
const {
  listBradescoSettledBankSlips,
  bradescoConfig
} = require('./bradesco');

const saoPauloDate = (value = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const addDays = (date, amount) => {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(amount || 0)))
    .toISOString()
    .slice(0, 10);
};

const configuredPositiveInteger = (value) => {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0;
};

const brudamConfigurationStatus = (env = process.env) => ({
  paymentMethod: configuredPositiveInteger(env.BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID),
  itauAccount: configuredPositiveInteger(env.BRUDAM_ITAU_BANK_ACCOUNT_ID),
  bradescoAccount: configuredPositiveInteger(env.BRUDAM_BRADESCO_BANK_ACCOUNT_ID)
});

const diagnosticError = (error) => ({
  ok: false,
  message: String(error?.message || 'Falha não identificada na consulta bancária.').slice(0, 300),
  ...(Number.isInteger(error?.upstreamStatus)
    ? { upstreamStatus: error.upstreamStatus }
    : {}),
  ...(Number.isInteger(error?.statusCode)
    ? { statusCode: error.statusCode }
    : {})
});

const resolveConfig = (configured, fallback) => (
  typeof configured === 'function' ? configured() : configured || fallback()
);

const diagnoseItauQuery = async (currentDate, dependencies = {}) => {
  const config = resolveConfig(dependencies.itauConfig, itauBoletoConfig);
  const criteria = {
    beneficiaryId: config.beneficiaryId,
    wallet: config.wallet,
    inclusionDate: currentDate,
    view: 'basic'
  };
  const list = await (dependencies.queryItauBankSlips || queryItauBankSlips)(
    criteria,
    { config }
  );
  return {
    ok: true,
    bank: 'itau',
    operation: 'GET /boletos',
    queriedDate: currentDate,
    records: Array.isArray(list) ? list.length : 0
  };
};

const diagnoseBradescoQuery = async (currentDate, dependencies = {}) => {
  const config = resolveConfig(dependencies.bradescoConfig, bradescoConfig);
  const paymentDate = addDays(currentDate, -1);
  const list = await (
    dependencies.listBradescoSettledBankSlips || listBradescoSettledBankSlips
  )({
    paymentDateFrom: paymentDate,
    paymentDateTo: paymentDate
  }, {
    config,
    maxPages: 1
  });
  return {
    ok: true,
    bank: 'bradesco',
    operation: 'POST /boleto/cobranca-lista/v1/listar (consulta)',
    queriedDate: paymentDate,
    records: Array.isArray(list) ? list.length : 0
  };
};

const runBankQueryDiagnostic = async ({ now = new Date() } = {}, dependencies = {}) => {
  const currentDate = saoPauloDate(now);
  const [itau, bradesco] = await Promise.all([
    diagnoseItauQuery(currentDate, dependencies).catch(diagnosticError),
    diagnoseBradescoQuery(currentDate, dependencies).catch(diagnosticError)
  ]);
  return {
    ok: Boolean(itau.ok && bradesco.ok),
    readOnly: true,
    checkedAt: now.toISOString(),
    banks: { itau, bradesco },
    brudamConfiguration: brudamConfigurationStatus(dependencies.env || process.env)
  };
};

module.exports = {
  saoPauloDate,
  addDays,
  configuredPositiveInteger,
  brudamConfigurationStatus,
  diagnosticError,
  diagnoseItauQuery,
  diagnoseBradescoQuery,
  runBankQueryDiagnostic
};
