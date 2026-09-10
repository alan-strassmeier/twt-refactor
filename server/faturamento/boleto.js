const { createHash } = require('node:crypto');
const { normalizeInvoice } = require('./brudam');
const {
  requestExactInvoice,
  fetchCompany
} = require('./invoice-pdf');
const { findDoccobForInvoice } = require('./r2-doccob');
const {
  bankSlipBankForIssuer,
  requiresTedDocPayment
} = require('./billing-rules');
const {
  bradescoConfig,
  createBradescoBankSlip,
  queryBradescoBankSlip
} = require('./bradesco');
const {
  itauBoletoConfig,
  createItauBankSlip,
  queryItauBankSlips
} = require('./itau');
const { renderItauBankSlipPdf } = require('./itau-boleto-pdf');
const { renderBradescoBankSlipPdf } = require('./bradesco-boleto-pdf');
const store = require('./boleto-store');

const digits = (value) => String(value || '').replace(/\D/g, '');
const firstValue = (object, keys) => {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
};

const validInvoiceId = (value) => /^\d{1,20}$/.test(String(value || '')) && Number(value) > 0;

const externalReferenceForInvoice = (invoiceId, prefix = 'TWT') => {
  const number = digits(invoiceId);
  const safePrefix = String(prefix || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 3) || 'FAT';
  const readable = `${safePrefix}${number}`;
  if (readable.length <= 10) return readable;
  return `${safePrefix}${createHash('sha256').update(number).digest('hex').slice(0, 10 - safePrefix.length).toUpperCase()}`;
};

const dateOnly = (value) => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || '';
};

const saoPauloDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).map(({ type, value: part }) => [type, part])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const validationError = (message) => Object.assign(new Error(message), { statusCode: 422 });

const payerFromCompany = (company, fallback = {}) => {
  const taxId = digits(firstValue(company, ['cnpj', 'cpf_cnpj', 'documento']) || fallback.taxId);
  const name = String(
    firstValue(company, ['razao', 'razao_social', 'nome', 'fantasia']) || fallback.name || ''
  ).trim().slice(0, 40);
  const number = String(firstValue(company, ['numero', 'nro']) || '').trim().slice(0, 10);
  const state = String(firstValue(company, ['uf', 'UF', 'estado']) || '').trim().toUpperCase();
  const zipCode = digits(firstValue(company, ['cep', 'CEP']));
  const city = String(firstValue(company, ['cidade', 'municipio', 'xMun']) || '').trim().slice(0, 40);
  const district = String(firstValue(company, ['bairro', 'xBairro']) || '').trim().slice(0, 40);
  const street = String(firstValue(company, ['endereco', 'logradouro', 'xLgr']) || '')
    .trim()
    .slice(0, 40);
  const complement = String(firstValue(company, ['complemento', 'xCpl']) || '').trim().slice(0, 24);
  const email = String(firstValue(company, ['email']) || '').trim().toLowerCase();

  if (![11, 14].includes(taxId.length)) throw validationError('CPF/CNPJ do pagador não está completo.');
  if (!name) throw validationError('Razão social do pagador não está preenchida.');
  if (!street || !number || !city || !/^[A-Z]{2}$/.test(state) || zipCode.length !== 8) {
    throw validationError(
      'O cadastro do pagador precisa ter logradouro, número, cidade, UF e CEP válidos para gerar boleto.'
    );
  }

  return {
    name,
    tax_id: taxId,
    ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email: email.slice(0, 200) } : {}),
    address: {
      street,
      number,
      ...(complement ? { complement } : {}),
      ...(district ? { district } : {}),
      city,
      state,
      zip_code: zipCode
    }
  };
};

const issuerFromInvoice = (invoice, doccob) => digits(
  doccob?.invoice?.issuerCnpj ||
  firstValue(invoice, ['cnpj_emitente', 'cnpj_empresa', 'emitente_cnpj']) ||
  invoice?.emitente?.cnpj
);

const resolveInvoiceBillingData = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const requestInvoice = dependencies.requestExactInvoice || requestExactInvoice;
  const findDoccob = dependencies.findDoccobForInvoice || findDoccobForInvoice;
  const getCompany = dependencies.fetchCompany || fetchCompany;
  const now = dependencies.now || new Date();
  const { invoice } = await requestInvoice(invoiceId);
  const normalized = normalizeInvoice(invoice);
  const normalizedInvoiceId = String(normalized.id || invoiceId);
  const clientCnpj = digits(normalized.clientDocument);

  let doccob = null;
  try {
    doccob = await findDoccob({
      invoiceId: normalizedInvoiceId,
      clientCnpj
    });
  } catch (error) {
    throw Object.assign(new Error('Não foi possível confirmar o emitente da fatura no DOCCOB.'), {
      statusCode: 503,
      expose: true,
      cause: error
    });
  }

  const issuerCnpj = issuerFromInvoice(invoice, doccob);
  const bank = bankSlipBankForIssuer(issuerCnpj);
  if (!bank) {
    throw Object.assign(new Error('O emitente da fatura não possui banco de cobrança configurado.'), {
      statusCode: 403
    });
  }
  if (normalized.status === 1) throw validationError('A fatura já está liquidada.');
  if (normalized.status === 2) throw validationError('Não é possível gerar boleto para uma fatura cancelada.');

  const amount = Number(normalized.balance ?? normalized.total);
  if (!Number.isFinite(amount) || amount <= 0) throw validationError('A fatura não possui saldo pendente válido.');
  const dueAt = dateOnly(normalized.dueAt || doccob?.invoice?.dueAt);
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )).toISOString().slice(0, 10);
  if (!dueAt) throw validationError('A fatura não possui data de vencimento válida.');
  if (dueAt < today) {
    throw validationError('O vencimento da fatura já passou. Atualize o vencimento na Brudam antes de gerar o boleto.');
  }
  if (clientCnpj.length !== 14) throw validationError('CNPJ do cliente não está completo.');

  const company = await getCompany(clientCnpj);
  if (!company) throw validationError('Cadastro do pagador não encontrado na Brudam.');
  const paymentMethod = firstValue(invoice, [
    'forma_pagamento', 'forma_pgto', 'forma_pagto', 'meio_pagamento',
    'descricao_forma_pagamento', 'tipo_pagamento'
  ]);
  if (requiresTedDocPayment({
    clientNames: [
      normalized.client,
      firstValue(company, ['fantasia', 'xFant']),
      firstValue(company, ['razao', 'razao_social', 'nome', 'xNome'])
    ],
    clientDocument: clientCnpj,
    paymentMethod
  })) {
    throw validationError(
      'Esta fatura utiliza transferência TED/DOC e não deve gerar boleto.'
    );
  }

  return {
    invoiceId: normalizedInvoiceId,
    issuerCnpj,
    bank,
    amount: Number(amount.toFixed(2)),
    issuedAt: dateOnly(normalized.issuedAt),
    dueAt,
    payer: payerFromCompany(company, {
      taxId: clientCnpj,
      name: normalized.client
    })
  };
};

const bradescoText = (value, maxLength) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const bradescoDate = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw validationError('Data da fatura inválida para o Bradesco.');
  return `${match[3]}.${match[2]}.${match[1]}`;
};

const bradescoMoney = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 100000000) {
    throw validationError('Valor do boleto fora do limite aceito pelo Bradesco.');
  }
  return amount.toFixed(2);
};

const bradescoBankSlipPayload = (billing, config) => {
  const payer = billing.payer;
  const address = payer.address;
  const zipCode = digits(address.zip_code);
  const reference = `FAT${digits(billing.invoiceId)}`.slice(0, 25);
  const district = bradescoText(address.district, 40);
  if (!billing.issuedAt) throw validationError('A fatura não possui data de emissão válida.');
  if (zipCode.length !== 8) throw validationError('CEP do pagador inválido para o Bradesco.');
  if (!district) {
    throw validationError('O cadastro do pagador precisa ter bairro preenchido para gerar boleto Bradesco.');
  }

  return {
    debitoAutomatico: 'N',
    nuCPFCNPJ: config.beneficiaryRoot,
    filialCPFCNPJ: config.beneficiaryBranch,
    ctrlCPFCNPJ: config.beneficiaryControl,
    idProduto: config.productId,
    nuNegociacao: config.registrationNegotiation,
    nuTitulo: '0',
    nuCliente: reference,
    dtEmissaoTitulo: bradescoDate(billing.issuedAt),
    dtVencimentoTitulo: bradescoDate(billing.dueAt),
    indicadorMoeda: '1',
    vlNominalTitulo: bradescoMoney(billing.amount),
    qmoedaNegocTitlo: '0',
    cdEspecieTitulo: config.species,
    cindcdAceitSacdo: config.acceptance,
    tpVencimento: '0',
    tpProtestoAutomaticoNegativacao: '0',
    prazoProtestoAutomaticoNegativacao: '0',
    controleParticipante: reference,
    cdPagamentoParcial: 'N',
    qtdePagamentoParcial: '0',
    tipoPrazoDecursoTres: '0',
    percentualJuros: config.monthlyInterestPercent.toFixed(2),
    vlJuros: '0',
    qtdeDiasJuros: config.interestStartDays,
    percentualMulta: config.penaltyPercent.toFixed(2),
    vlMulta: '0',
    qtdeDiasMulta: config.penaltyStartDays,
    percentualDesconto1: '0',
    vlDesconto1: '0',
    dataLimiteDesconto1: '',
    percentualDesconto2: '0',
    vlDesconto2: '0',
    dataLimiteDesconto2: '',
    percentualDesconto3: '0',
    vlDesconto3: '0',
    dataLimiteDesconto3: '',
    prazoBonificacao: '0',
    percentualBonificacao: '0',
    vlBonificacao: '0',
    dtLimiteBonificacao: '',
    vlAbatimento: '0',
    vlIOF: '0',
    nomePagador: bradescoText(payer.name, 70),
    logradouroPagador: bradescoText(address.street, 40),
    nuLogradouroPagador: bradescoText(address.number, 10),
    complementoLogradouroPagador: bradescoText(address.complement, 15),
    cepPagador: zipCode.slice(0, 5),
    complementoCepPagador: zipCode.slice(5),
    bairroPagador: district,
    municipioPagador: bradescoText(address.city, 30),
    ufPagador: String(address.state || '').toUpperCase(),
    cdIndCpfcnpjPagador: digits(payer.tax_id).length === 14 ? '2' : '1',
    nuCpfcnpjPagador: digits(payer.tax_id),
    endEletronicoPagador: String(payer.email || '').slice(0, 70),
    dddFoneSacado: '0',
    foneSacado: '0',
    listaMsgs: [
      { mensagem: bradescoText(`REFERENTE A FATURA ${billing.invoiceId}`, 80) },
      { mensagem: 'APOS O VENCIMENTO MULTA DE 3 POR CENTO' },
      { mensagem: 'APOS O VENCIMENTO JUROS DE 0 15 POR CENTO AO DIA' }
    ]
  };
};

const itauOurNumberForInvoice = (invoiceId) => {
  const number = digits(invoiceId);
  if (number.length <= 16) return number.padStart(8, '0');
  const hexadecimal = createHash('sha256').update(number).digest('hex').slice(0, 13);
  return (BigInt(`0x${hexadecimal}`) % 10000000000000000n).toString().padStart(16, '0');
};

const itauAmountForPayload = (value) => {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || String(cents).length > 17) {
    throw validationError('Valor do boleto fora do limite aceito pelo Itaú.');
  }
  return String(cents).padStart(17, '0');
};

const itauBankSlipPayload = (billing, config) => {
  const payerTaxId = digits(billing.payer.tax_id);
  const personType = payerTaxId.length === 14
    ? {
        codigo_tipo_pessoa: 'J',
        numero_cadastro_nacional_pessoa_juridica: payerTaxId
      }
    : {
        codigo_tipo_pessoa: 'F',
        numero_cadastro_pessoa_fisica: payerTaxId
      };
  const payerAddress = billing.payer.address;
  const street = [payerAddress.street, payerAddress.number, payerAddress.complement]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .join(', ')
    .slice(0, 100);
  const ourNumber = itauOurNumberForInvoice(billing.invoiceId);
  const yourNumber = `FAT${digits(billing.invoiceId)}`.slice(0, 20);

  return {
    etapa_processo_boleto: config.stage,
    codigo_canal_operacao: 'API',
    beneficiario: {
      id_beneficiario: config.beneficiaryId
    },
    dado_boleto: {
      descricao_instrumento_cobranca: 'boleto',
      pagador: {
        pessoa: {
          nome_pessoa: billing.payer.name,
          tipo_pessoa: personType
        },
        endereco: {
          nome_logradouro: street,
          nome_bairro: payerAddress.district || '',
          nome_cidade: payerAddress.city,
          sigla_UF: payerAddress.state,
          numero_CEP: payerAddress.zip_code
        },
        ...(billing.payer.email ? { texto_endereco_email: billing.payer.email } : {})
      },
      codigo_carteira: config.wallet,
      dados_individuais_boleto: [{
        numero_nosso_numero: ourNumber,
        data_vencimento: billing.dueAt,
        valor_titulo: itauAmountForPayload(billing.amount),
        texto_seu_numero: yourNumber,
        texto_uso_beneficiario: yourNumber
      }],
      codigo_especie: config.species,
      codigo_aceite: config.acceptance,
      ...(billing.issuedAt ? { data_emissao: billing.issuedAt } : {}),
      pagamento_parcial: false,
      desconto_expresso: false
    }
  };
};

const publicRecord = (record, created = false) => ({
  invoiceId: record.invoiceId,
  status: record.state,
  created,
  amount: record.amount,
  dueAt: record.dueAt,
  bank: record.bank || '',
  digitableLine: record.digitableLine || '',
  barCode: record.barCode || '',
  ...(record.state === 'validated'
    ? { message: 'Dados validados pelo Itaú. Nenhum boleto foi registrado.' }
    : {})
});

const generationConflict = (state) => Object.assign(
  new Error(state === 'review'
    ? 'A tentativa anterior precisa de conferência antes de gerar outro boleto.'
    : 'A geração deste boleto já está em andamento.'),
  { statusCode: 409 }
);

const itauBankSlipId = (bankResponse, payload, config) => {
  const detail = payload?.dado_boleto?.dados_individuais_boleto?.[0] || {};
  const beneficiaryId = digits(bankResponse?.beneficiaryId || config?.beneficiaryId);
  const wallet = digits(bankResponse?.wallet || config?.wallet);
  const ourNumber = digits(bankResponse?.ourNumber || detail.numero_nosso_numero);
  if (
    beneficiaryId.length !== 12 ||
    wallet.length !== 3 ||
    ourNumber.length < 8 ||
    ourNumber.length > 16
  ) return '';
  return `${beneficiaryId}${wallet}${ourNumber}`;
};

const normalizeRegisteredItauResponse = (bankResponse, payload, config) => ({
  ...bankResponse,
  id: String(bankResponse?.id || itauBankSlipId(bankResponse, payload, config)).trim()
});

const readyRecordFromBankResponse = ({
  billing,
  config,
  payload,
  bankResponse,
  now,
  isItau,
  isBradesco = false
}) => {
  const itauDetail = payload?.dado_boleto?.dados_individuais_boleto?.[0] || {};
  const responseAmount = Number(bankResponse.amount);
  return {
    state: 'ready',
    invoiceId: billing.invoiceId,
    issuerCnpj: billing.issuerCnpj,
    bank: billing.bank.id,
    bankSlipId: bankResponse.id,
    externalReferenceId: payload.nuCliente || itauDetail.texto_seu_numero || '',
    amount: Number.isFinite(responseAmount) && responseAmount > 0
      ? responseAmount
      : billing.amount,
    issuedAt: billing.issuedAt,
    dueAt: dateOnly(bankResponse.dueDate || bankResponse.due_date) || billing.dueAt,
    digitableLine: String(bankResponse.digitableLine || bankResponse.digitable_line || ''),
    barCode: String(bankResponse.barCode || bankResponse.bar_code || ''),
    payer: billing.payer,
    ...(isItau ? {
      beneficiaryId: config.beneficiaryId,
      beneficiaryName: config.beneficiaryName,
      beneficiaryTaxId: config.beneficiaryTaxId,
      wallet: bankResponse.wallet || config.wallet,
      ourNumber: bankResponse.ourNumber || itauDetail.numero_nosso_numero,
      yourNumber: bankResponse.yourNumber || itauDetail.texto_seu_numero,
      acceptance: config.acceptance,
      species: config.species,
      speciesLabel: 'DS',
      instructions: `Referente à fatura ${billing.invoiceId}. Não aceitar pagamento após o vencimento.`
    } : {}),
    ...(isBradesco ? {
      beneficiaryName: bankResponse.beneficiaryName || config.beneficiaryName,
      beneficiaryTaxId: bankResponse.beneficiaryTaxId || config.beneficiaryTaxId,
      agency: config.agency,
      agencyDigit: config.agencyDigit,
      account: config.account,
      accountDigit: config.accountDigit,
      wallet: String(bankResponse.wallet || config.productId).padStart(2, '0'),
      ourNumber: digits(bankResponse.ourNumber).padStart(11, '0'),
      yourNumber: bankResponse.yourNumber || payload.nuCliente,
      acceptance: 'N',
      species: config.species,
      speciesLabel: bankResponse.speciesLabel || 'DS',
      penaltyPercent: config.penaltyPercent,
      dailyInterestPercent: config.dailyInterestPercent,
      instructions: [
        `Referente a fatura ${billing.invoiceId}.`,
        `Apos o vencimento multa de ${config.penaltyPercent.toFixed(2).replace('.', ',')}%.`,
        `Apos o vencimento juros de ${config.dailyInterestPercent.toFixed(2).replace('.', ',')}% ao dia.`
      ].join('\n')
    } : {}),
    createdAt: now.toISOString()
  };
};

const validRegisteredItauResponse = (bankResponse) => Boolean(
  bankResponse?.id &&
  digits(bankResponse.digitableLine).length >= 47 &&
  digits(bankResponse.barCode).length === 44
);

const validRegisteredBradescoResponse = (bankResponse) => Boolean(
  digits(bankResponse?.id).length === 11 &&
  digits(bankResponse?.ourNumber).length === 11 &&
  digits(bankResponse?.digitableLine).length === 47 &&
  digits(bankResponse?.barCode).length === 44
);

const sameMoney = (left, right) => (
  Number.isFinite(Number(left)) &&
  Math.round(Number(left) * 100) === Math.round(Number(right) * 100)
);

const itauBankSlipMatchesInvoice = (bankResponse, billing, payload, allowFinancialMatch = false) => {
  const expected = payload?.dado_boleto?.dados_individuais_boleto?.[0] || {};
  const invoiceId = digits(billing.invoiceId);
  const ourNumberMatches = digits(bankResponse.ourNumber) === digits(expected.numero_nosso_numero);
  const yourNumber = digits(bankResponse.yourNumber);
  const invoiceReferenceMatches = Boolean(yourNumber) && (
    yourNumber === invoiceId || yourNumber.endsWith(invoiceId)
  );
  if (ourNumberMatches || invoiceReferenceMatches) return true;
  if (!allowFinancialMatch) return false;

  return (
    digits(bankResponse.payerTaxId) === digits(billing.payer.tax_id) &&
    dateOnly(bankResponse.dueDate) === billing.dueAt &&
    sameMoney(bankResponse.amount, billing.amount)
  );
};

const findExistingItauBankSlip = async ({
  billing,
  config,
  payload,
  query,
  attemptedAt = ''
}) => {
  const detail = payload.dado_boleto.dados_individuais_boleto[0];
  const dates = [...new Set([
    attemptedAt ? saoPauloDate(attemptedAt) : '',
    attemptedAt ? dateOnly(attemptedAt) : '',
    billing.issuedAt
  ].filter(Boolean))];
  const searches = [
    ...dates.map((inclusionDate) => ({
      criteria: {
        beneficiaryId: config.beneficiaryId,
        wallet: config.wallet,
        ourNumber: detail.numero_nosso_numero,
        inclusionDate,
        view: 'specific'
      },
      allowFinancialMatch: false
    })),
    {
      criteria: {
        beneficiaryId: config.beneficiaryId,
        wallet: config.wallet,
        ourNumber: detail.numero_nosso_numero,
        view: 'full'
      },
      allowFinancialMatch: false
    },
    ...dates.map((inclusionDate) => ({
      criteria: {
        beneficiaryId: config.beneficiaryId,
        wallet: config.wallet,
        inclusionDate,
        view: 'full'
      },
      allowFinancialMatch: true
    }))
  ];
  const errors = [];
  let successfulSearches = 0;
  let successfulFinancialSearches = 0;

  for (const search of searches) {
    let matches;
    try {
      matches = await query(search.criteria, { config });
      successfulSearches += 1;
      if (search.allowFinancialMatch) successfulFinancialSearches += 1;
    } catch (error) {
      errors.push(error);
      continue;
    }
    const candidates = (matches || [])
      .map((match) => normalizeRegisteredItauResponse(match, payload, config))
      .filter((match) => (
        validRegisteredItauResponse(match) &&
        itauBankSlipMatchesInvoice(match, billing, payload, search.allowFinancialMatch)
      ));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const references = candidates.filter((match) => (
        itauBankSlipMatchesInvoice(match, billing, payload, false)
      ));
      if (references.length === 1) return references[0];
      throw Object.assign(new Error(
        'O Itaú retornou mais de um boleto compatível com esta fatura. Confira os títulos no Bankline.'
      ), { statusCode: 409 });
    }
  }

  if (dates.length && !successfulFinancialSearches) {
    const financialError = errors.find((error) => error);
    if (financialError) throw financialError;
  }
  if (!successfulSearches && errors.length) throw errors[0];
  return null;
};

const itauLookupError = (prefix, error) => {
  const upstreamStatus = Number(error?.upstreamStatus);
  const statusCode = upstreamStatus === 403
    ? 403
    : (error?.statusCode === 422 ? 422 : 503);
  const safeMessage = String(error?.message || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  let detail = '';
  if (Number.isInteger(upstreamStatus) && upstreamStatus > 0) {
    detail = ` O Itaú respondeu HTTP ${upstreamStatus}${safeMessage ? `: ${safeMessage}` : '.'}`;
  } else if (error?.expose && safeMessage) {
    detail = ` ${safeMessage}`;
  } else if (error?.name === 'AbortError' || error?.statusCode === 504) {
    detail = ' A consulta ao Itaú excedeu o tempo limite.';
  } else if (/^[A-Z][A-Z0-9_]+$/.test(String(error?.code || ''))) {
    detail = ` Falha de comunicação com o Itaú (${error.code}).`;
  } else {
    detail = ' A consulta falhou antes de receber uma resposta HTTP.';
  }
  return Object.assign(new Error(`${prefix}.${detail}`.trim()), {
    statusCode,
    expose: true,
    cause: error,
    ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}),
    ...(Array.isArray(error?.validationDetails)
      ? { validationDetails: error.validationDetails }
      : {})
  });
};

const bradescoLookupError = (prefix, error) => {
  const upstreamStatus = Number(error?.upstreamStatus);
  const statusCode = [401, 403].includes(upstreamStatus)
    ? upstreamStatus
    : (error?.statusCode === 422 ? 422 : 503);
  const safeMessage = String(error?.message || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const detail = Number.isInteger(upstreamStatus) && upstreamStatus > 0
    ? ` O Bradesco respondeu HTTP ${upstreamStatus}${safeMessage ? `: ${safeMessage}` : '.'}`
    : (error?.expose && safeMessage
        ? ` ${safeMessage}`
        : ' A consulta falhou antes de receber uma resposta HTTP.');
  return Object.assign(new Error(`${prefix}.${detail}`.trim()), {
    statusCode,
    expose: true,
    cause: error,
    ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {})
  });
};

const generateInvoiceBankSlip = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const getRecord = dependencies.getBankSlipRecord || store.getBankSlipRecord;
  const claim = dependencies.claimBankSlip || store.claimBankSlip;
  const save = dependencies.saveBankSlipRecord || store.saveBankSlipRecord;
  const release = dependencies.releaseBankSlipClaim || store.releaseBankSlipClaim;
  const now = dependencies.now || new Date();
  const normalizedInvoiceId = String(invoiceId);
  const billing = await resolveInvoiceBillingData(normalizedInvoiceId, dependencies);
  const existing = await getRecord(normalizedInvoiceId);
  const existingBank = existing?.bank || 'c6';
  if (existing && existingBank !== billing.bank.id) {
    throw Object.assign(new Error('Existe um registro bancário divergente para esta fatura. Faça a conferência antes de emitir outro boleto.'), {
      statusCode: 409
    });
  }
  if (existing?.state === 'ready') return publicRecord(existing, false);

  const isItau = billing.bank.id === 'itau';
  const isBradesco = billing.bank.id === 'bradesco';
  const getConfig = isItau
    ? (dependencies.itauBoletoConfig || itauBoletoConfig)
    : (dependencies.bradescoConfig || bradescoConfig);
  const create = isItau
    ? (dependencies.createItauBankSlip || createItauBankSlip)
    : (dependencies.createBradescoBankSlip || createBradescoBankSlip);
  const config = getConfig();
  const payload = isItau
    ? itauBankSlipPayload(billing, config)
    : bradescoBankSlipPayload(billing, config);

  if (existing?.state === 'review' && isItau) {
    const query = dependencies.queryItauBankSlips || queryItauBankSlips;
    const attemptedAt = existing.startedAt || existing.reviewedAt || now.toISOString();
    let recovered;
    try {
      recovered = await findExistingItauBankSlip({
        billing,
        config,
        payload,
        query,
        attemptedAt
      });
    } catch (error) {
      if (error.statusCode === 409) throw error;
      throw itauLookupError(
        'Não foi possível conferir no Itaú a tentativa anterior de emissão',
        error
      );
    }
    if (recovered) {
      const readyRecord = readyRecordFromBankResponse({
        billing,
        config,
        payload,
        bankResponse: recovered,
        now,
        isItau
      });
      await save(billing.invoiceId, readyRecord);
      return publicRecord(readyRecord, false);
    }
    throw Object.assign(new Error(
      'A tentativa anterior ainda não apareceu na consulta do Itaú. Confira o Bankline antes de emitir novamente.'
    ), { statusCode: 409 });
  }
  if (existing?.state === 'review' && isBradesco) {
    const ourNumber = digits(existing.ourNumber);
    if (ourNumber.length !== 11) {
      throw Object.assign(new Error(
        'A tentativa anterior no Bradesco não retornou Nosso Número. Confira o título no Net Empresa antes de emitir novamente.'
      ), { statusCode: 409 });
    }
    let recovered;
    try {
      const query = dependencies.queryBradescoBankSlip || queryBradescoBankSlip;
      recovered = await query(ourNumber, { config });
    } catch (error) {
      throw bradescoLookupError(
        'Não foi possível conferir no Bradesco a tentativa anterior de emissão',
        error
      );
    }
    if (!recovered || !validRegisteredBradescoResponse(recovered)) {
      throw Object.assign(new Error(
        'A tentativa anterior ainda não apareceu na consulta do Bradesco. Confira o Net Empresa antes de emitir novamente.'
      ), { statusCode: 409 });
    }
    const readyRecord = readyRecordFromBankResponse({
      billing,
      config,
      payload,
      bankResponse: recovered,
      now,
      isItau,
      isBradesco
    });
    await save(billing.invoiceId, readyRecord);
    return publicRecord(readyRecord, false);
  }
  if (existing?.state === 'processing' || existing?.state === 'review') {
    throw generationConflict(existing.state);
  }

  if (isItau && config.stage === 'validacao') {
    const validation = await create(payload, { config });
    if (validation.registered) {
      throw Object.assign(new Error(
        'O Itaú informou efetivação durante uma chamada de validação. Confira o título antes de tentar novamente.'
      ), {
        statusCode: 409,
        ambiguousBankState: true
      });
    }
    return publicRecord({
      state: 'validated',
      invoiceId: billing.invoiceId,
      bank: billing.bank.id,
      amount: billing.amount,
      dueAt: billing.dueAt,
      digitableLine: validation.digitableLine,
      barCode: validation.barCode
    }, false);
  }

  if (isItau && !config.skipPrecheck) {
    const query = dependencies.queryItauBankSlips || queryItauBankSlips;
    let recovered;
    try {
      recovered = await findExistingItauBankSlip({
        billing,
        config,
        payload,
        query,
        attemptedAt: now.toISOString()
      });
    } catch (error) {
      if (error.statusCode === 409) throw error;
      throw itauLookupError(
        'Não foi possível verificar se a fatura já possui boleto no Itaú',
        error
      );
    }
    if (recovered) {
      const readyRecord = readyRecordFromBankResponse({
        billing,
        config,
        payload,
        bankResponse: recovered,
        now,
        isItau,
        isBradesco
      });
      await save(billing.invoiceId, readyRecord);
      return publicRecord(readyRecord, false);
    }
  }

  const processingRecord = {
    state: 'processing',
    invoiceId: billing.invoiceId,
    issuerCnpj: billing.issuerCnpj,
    bank: billing.bank.id,
    startedAt: now.toISOString()
  };
  const claimed = await claim(billing.invoiceId, processingRecord);
  if (!claimed) {
    const concurrent = await getRecord(billing.invoiceId);
    if (concurrent?.state === 'ready') return publicRecord(concurrent, false);
    throw generationConflict(concurrent?.state);
  }

  let bankResponse = null;
  try {
    bankResponse = await create(payload, { config });
    if (isItau) bankResponse = normalizeRegisteredItauResponse(bankResponse, payload, config);
    const bankSlipId = String(bankResponse?.id || '').trim();
    if (!bankSlipId) {
      throw Object.assign(new Error(`O ${billing.bank.label} não retornou o identificador do boleto.`), {
        statusCode: 502,
        receivedResponse: true,
        ambiguousBankState: true
      });
    }
    if (isItau && (!bankResponse.registered || !validRegisteredItauResponse(bankResponse))) {
      throw Object.assign(new Error(
        'O Itaú recebeu a efetivação, mas não retornou a linha digitável e o código de barras completos.'
      ), {
        statusCode: 502,
        receivedResponse: true,
        ambiguousBankState: true
      });
    }
    if (isBradesco && (!bankResponse.registered || !validRegisteredBradescoResponse(bankResponse))) {
      throw Object.assign(new Error(
        'O Bradesco recebeu o registro, mas não retornou Nosso Número, linha digitável e código de barras completos.'
      ), {
        statusCode: 502,
        receivedResponse: true,
        ambiguousBankState: true,
        bankResponse
      });
    }
    const readyRecord = readyRecordFromBankResponse({
      billing,
      config,
      payload,
      bankResponse: { ...bankResponse, id: bankSlipId },
      now,
      isItau,
      isBradesco
    });
    await save(billing.invoiceId, readyRecord);
    return publicRecord(readyRecord, true);
  } catch (error) {
    if (bankResponse || error.ambiguousBankState) {
      const reviewRecord = {
        ...processingRecord,
        state: 'review',
        reviewedAt: now.toISOString(),
        ...((bankResponse?.ourNumber || error?.bankResponse?.ourNumber)
          ? { ourNumber: digits(bankResponse?.ourNumber || error.bankResponse.ourNumber).padStart(11, '0') }
          : {})
      };
      try { await save(billing.invoiceId, reviewRecord); } catch { /* mantém o lock original */ }
    } else {
      try { await release(billing.invoiceId); } catch { /* o lock expira em 24 horas */ }
    }
    throw error;
  }
};

const getInvoiceBankSlipPdf = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const getRecord = dependencies.getBankSlipRecord || store.getBankSlipRecord;
  const record = await getRecord(String(invoiceId));
  if (!record || record.state !== 'ready' || !record.bankSlipId) {
    throw Object.assign(new Error('Nenhum boleto foi gerado para esta fatura.'), { statusCode: 404 });
  }
  if (record.bank === 'itau') {
    const render = dependencies.renderItauBankSlipPdf || renderItauBankSlipPdf;
    return render(record);
  }
  if (record.bank === 'bradesco') {
    const render = dependencies.renderBradescoBankSlipPdf || renderBradescoBankSlipPdf;
    return render(record);
  }
  throw Object.assign(new Error(
    'O boleto armazenado pertence a uma integração bancária que não está mais ativa.'
  ), { statusCode: 409 });
};

module.exports = {
  externalReferenceForInvoice,
  payerFromCompany,
  issuerFromInvoice,
  resolveInvoiceBillingData,
  bradescoText,
  bradescoDate,
  bradescoMoney,
  bradescoBankSlipPayload,
  itauOurNumberForInvoice,
  itauAmountForPayload,
  itauBankSlipPayload,
  itauBankSlipId,
  itauLookupError,
  bradescoLookupError,
  generateInvoiceBankSlip,
  getInvoiceBankSlipPdf
};
