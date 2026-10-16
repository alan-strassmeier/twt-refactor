const { sessionFromRequest } = require('../../server/faturamento/auth');
const { queryFromRequest, sendJson } = require('../../server/faturamento/http');
const { getBankSlipRecord } = require('../../server/faturamento/boleto-store');
const {
  itauBoletoConfig,
  queryItauBankSlipDetail
} = require('../../server/faturamento/itau');

const TEST_INVOICE_IDS = new Set(['11817', '11838']);
const DIAGNOSTIC_EXPIRES_AT = Date.parse('2026-10-18T00:00:00Z');
const digits = (value) => String(value || '').replace(/\D/g, '');

const createHandler = (dependencies = {}) => async (req, res) => {
  const env = dependencies.env || process.env;
  const session = dependencies.sessionFromRequest || sessionFromRequest;
  const readRecord = dependencies.getBankSlipRecord || getBankSlipRecord;
  const configFor = dependencies.itauBoletoConfig || itauBoletoConfig;
  const queryBank = dependencies.queryItauBankSlipDetail || queryItauBankSlipDetail;
  const now = dependencies.now || Date.now;

  // Restringe também deployments antigos, que permanecem acessíveis após o cleanup.
  if (env.VERCEL_ENV !== 'preview' || now() >= DIAGNOSTIC_EXPIRES_AT) {
    sendJson(res, 404, { message: 'Rota não encontrada.' });
    return;
  }
  if (!session(req)) {
    sendJson(res, 401, { message: 'Faça login para consultar o boleto.' });
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }

  const invoiceId = String(queryFromRequest(req).id || '');
  if (!TEST_INVOICE_IDS.has(invoiceId)) {
    sendJson(res, 404, { message: 'Fatura não habilitada para este diagnóstico.' });
    return;
  }

  try {
    const config = configFor(env);
    const record = await readRecord(invoiceId);
    const ourNumber = String(record?.ourNumber || '');
    if (record?.state !== 'ready' || record.bank !== 'itau' ||
        (record.invoiceId && String(record.invoiceId) !== invoiceId) ||
        digits(record.beneficiaryId) !== digits(config.beneficiaryId) ||
        digits(record.wallet) !== digits(config.wallet) ||
        !/^\d{1,8}$/.test(ourNumber)) {
      sendJson(res, 404, { message: 'Boleto Itaú registrado não encontrado.' });
      return;
    }

    const result = await queryBank({
      beneficiaryId: config.beneficiaryId,
      wallet: config.wallet,
      ourNumber
    }, { config, includeRaw: true });
    const bankData = result.raw;
    const matches = (item) => digits(item?.beneficiario?.id_beneficiario) ===
      digits(config.beneficiaryId) &&
      digits(item?.dado_boleto?.codigo_carteira) === digits(config.wallet) &&
      item?.dado_boleto?.dados_individuais_boleto?.some((detail) =>
        digits(detail?.numero_nosso_numero) === digits(ourNumber));
    if (!bankData || !Array.isArray(bankData.data) || bankData.data.length !== 1 ||
        !bankData.data.every(matches)) {
      sendJson(res, 502, { message: 'A resposta do Itaú não corresponde ao boleto solicitado.' });
      return;
    }
    sendJson(res, 200, {
      readOnly: true,
      invoiceId,
      upstreamStatus: result.upstreamStatus,
      response: bankData
    });
  } catch (error) {
    sendJson(res, 502, {
      message: 'Não foi possível consultar o boleto no Itaú.',
      ...(Number.isInteger(error.upstreamStatus)
        ? { upstreamStatus: error.upstreamStatus } : {})
    });
  }
};

module.exports = createHandler();
module.exports.createHandler = createHandler;
