const {
  sendJson,
  parseJsonBody,
  hasSameOrigin,
  clientAddress
} = require('../server/faturamento/http');
const {
  MAX_BODY_BYTES,
  validateSubmission,
  sendSubmission,
  allowSubmission
} = require('../server/public-forms');

const createHandler = ({ send = sendSubmission, allow = allowSubmission } = {}) => async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Método não permitido.' });
    return;
  }
  if (!hasSameOrigin(req)) {
    sendJson(res, 403, { message: 'Origem da solicitação inválida.' });
    return;
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, { message: 'Formato de envio inválido.' });
    return;
  }

  try {
    const payload = await parseJsonBody(req, MAX_BODY_BYTES);
    if (Buffer.byteLength(JSON.stringify(payload) || '') > MAX_BODY_BYTES) {
      sendJson(res, 413, { message: 'Formulário muito grande.' });
      return;
    }
    if (payload?.website) {
      sendJson(res, 200, { message: 'Mensagem recebida.' });
      return;
    }
    const submission = validateSubmission(payload);
    if (!await allow(clientAddress(req))) {
      sendJson(res, 429, { message: 'Muitas tentativas. Tente novamente mais tarde.' });
      return;
    }
    await send(submission);
    sendJson(res, 200, { message: 'E-mail enviado com sucesso.' });
  } catch (error) {
    const statusCode = error instanceof SyntaxError
      ? 400
      : Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (statusCode >= 500) console.error('[public-form]', error);
    sendJson(res, statusCode, {
      message: error instanceof SyntaxError
        ? 'Dados inválidos.'
        : statusCode < 500
        ? error.message
        : 'Não foi possível enviar o e-mail. Tente novamente mais tarde.'
    });
  }
};

module.exports = createHandler();
module.exports.createHandler = createHandler;
