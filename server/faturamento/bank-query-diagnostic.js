const {
  queryItauBankSlips,
  queryItauBankSlipDetail,
  itauBoletoConfig
} = require('./itau');
const { getBankSlipRecord, listBankSlipRecords } = require('./boleto-store');
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
    : {}),
  ...(error?.responseShape ? { responseShape: error.responseShape } : {})
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
    operation: 'GET /boleto/v1/boletos',
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

const diagnoseItauDetailQuery = async ({ invoiceId = '' } = {}, dependencies = {}) => {
  const config = resolveConfig(dependencies.itauConfig, itauBoletoConfig);
  const digits = (value) => String(value || '').replace(/\D/g, '');
  const matchesItauConfig = (record) => record.state === 'ready' && record.bank === 'itau' &&
    digits(record.beneficiaryId) === digits(config.beneficiaryId) &&
    digits(record.wallet) === digits(config.wallet) &&
    /^\d{1,8}$/.test(String(record.ourNumber || ''));
  const requestedInvoiceId = digits(invoiceId);
  const requestedRecord = requestedInvoiceId
    ? await (dependencies.getBankSlipRecord || getBankSlipRecord)(requestedInvoiceId)
    : null;
  const records = requestedInvoiceId ? []
    : await (dependencies.listBankSlipRecords || listBankSlipRecords)();
  const sample = requestedInvoiceId
    ? (requestedRecord && { ...requestedRecord, invoiceId: requestedInvoiceId })
    : records.filter(matchesItauConfig)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
  if (!sample) {
    return {
      ok: false,
      bank: 'itau',
      operation: 'GET /boletoscash/v2/boletos',
      reason: 'no_registered_sample',
      message: requestedInvoiceId
        ? 'Não há boleto registrado para esta fatura no controle local.'
        : 'Nenhum boleto Itaú registrado foi encontrado para testar a consulta v2.'
    };
  }
  if (!matchesItauConfig(sample)) {
    return {
      ok: false,
      bank: 'itau',
      operation: 'GET /boletoscash/v2/boletos',
      invoiceId: sample.invoiceId,
      reason: 'not_eligible_sample',
      message: 'A fatura informada não possui boleto Itaú registrado com os identificadores configurados.'
    };
  }
  try {
    const response = await (dependencies.queryItauBankSlipDetail || queryItauBankSlipDetail)({
      beneficiaryId: config.beneficiaryId,
      wallet: config.wallet,
      ourNumber: sample.ourNumber
    }, { config });
    return {
      ok: true,
      bank: 'itau',
      operation: 'GET /boletoscash/v2/boletos',
      invoiceId: sample.invoiceId,
      upstreamStatus: response.upstreamStatus,
      records: response.data.length,
      statuses: [...new Set(response.data.flatMap((item) =>
        (Array.isArray(item?.dado_boleto?.dados_individuais_boleto)
          ? item.dado_boleto.dados_individuais_boleto : [])
          .map((detail) => String(detail?.situacao_geral_boleto || '').trim())
          .filter(Boolean)))].slice(0, 5),
      statusFieldsPresent: response.data.some((item) =>
        Array.isArray(item?.dado_boleto?.dados_individuais_boleto) &&
        item.dado_boleto.dados_individuais_boleto.some((detail) =>
          typeof detail?.situacao_geral_boleto === 'string')),
      paymentEntries: response.data.reduce((total, item) => total +
        (Array.isArray(item?.dado_boleto?.pagamentos_cobranca)
          ? item.dado_boleto.pagamentos_cobranca.length : 0), 0)
    };
  } catch (error) {
    const upstreamStatus = Number.isInteger(error.upstreamStatus) ? error.upstreamStatus : null;
    const reason = upstreamStatus === 403 ? 'forbidden'
      : upstreamStatus === 401 ? 'unauthorized'
        : upstreamStatus === 404 ? 'not_found'
          : upstreamStatus === 400 || upstreamStatus === 422 ? 'invalid_request'
            : 'query_failed';
    return {
      ok: false,
      bank: 'itau',
      operation: 'GET /boletoscash/v2/boletos',
      invoiceId: sample.invoiceId,
      reason,
      ...(upstreamStatus ? { upstreamStatus } : {}),
      message: {
        forbidden: 'O Itaú não autorizou a consulta v2 para esta aplicação.',
        unauthorized: 'O Itaú não aceitou a autenticação da consulta v2.',
        not_found: 'O Itaú não encontrou o boleto de amostra na consulta v2.',
        invalid_request: 'O Itaú recusou os parâmetros da consulta v2.',
        query_failed: 'A consulta v2 do Itaú não pôde ser concluída.'
      }[reason]
    };
  }
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
  diagnoseItauDetailQuery,
  diagnoseBradescoQuery,
  runBankQueryDiagnostic
};
