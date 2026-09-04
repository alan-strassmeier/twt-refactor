const { createHash } = require('node:crypto');
const { normalizeInvoice } = require('./brudam');
const {
  requestExactInvoice,
  fetchCompany
} = require('./invoice-pdf');
const { findDoccobForInvoice } = require('./r2-doccob');
const { bankSlipBankForIssuer } = require('./billing-rules');
const {
  c6Config,
  createC6BankSlip,
  getC6BankSlipPdf
} = require('./c6');
const {
  itauBoletoConfig,
  createItauBankSlip
} = require('./itau');
const { renderItauBankSlipPdf } = require('./itau-boleto-pdf');
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

const validationError = (message) => Object.assign(new Error(message), { statusCode: 422 });

const payerFromCompany = (company, fallback = {}) => {
  const taxId = digits(firstValue(company, ['cnpj', 'cpf_cnpj', 'documento']) || fallback.taxId);
  const name = String(
    firstValue(company, ['razao', 'razao_social', 'nome', 'fantasia']) || fallback.name || ''
  ).trim().slice(0, 40);
  const numberText = String(firstValue(company, ['numero', 'nro']) || '').trim();
  const numberMatch = numberText.match(/\d+/);
  const number = numberMatch ? Number(numberMatch[0]) : null;
  const state = String(firstValue(company, ['uf', 'UF', 'estado']) || '').trim().toUpperCase();
  const zipCode = digits(firstValue(company, ['cep', 'CEP']));
  const city = String(firstValue(company, ['cidade', 'municipio', 'xMun']) || '').trim().slice(0, 40);
  const district = String(firstValue(company, ['bairro', 'xBairro']) || '').trim().slice(0, 40);
  const numberLength = number === null ? 0 : String(number).length;
  const streetLimit = Math.max(1, Math.min(33, 40 - numberLength));
  const street = String(firstValue(company, ['endereco', 'logradouro', 'xLgr']) || '')
    .trim()
    .slice(0, streetLimit);
  const complement = String(firstValue(company, ['complemento', 'xCpl']) || '').trim().slice(0, 24);
  const email = String(firstValue(company, ['email']) || '').trim().toLowerCase();

  if (![11, 14].includes(taxId.length)) throw validationError('CPF/CNPJ do pagador não está completo.');
  if (!name) throw validationError('Razão social do pagador não está preenchida.');
  if (!street || number === null || !city || !/^[A-Z]{2}$/.test(state) || zipCode.length !== 8) {
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

const c6Payer = (payer) => ({
  name: payer.name,
  tax_id: payer.tax_id,
  ...(payer.email ? { email: payer.email } : {}),
  address: {
    street: payer.address.street,
    number: payer.address.number,
    ...(payer.address.complement ? { complement: payer.address.complement } : {}),
    city: payer.address.city,
    state: payer.address.state,
    zip_code: payer.address.zip_code
  }
});

const bankSlipPayload = (billing, config) => ({
  external_reference_id: externalReferenceForInvoice(billing.invoiceId),
  amount: billing.amount,
  due_date: billing.dueAt,
  instructions: [`Fatura ${billing.invoiceId} - TWT Airpack`],
  billing_scheme: config.billingScheme,
  payer: c6Payer(billing.payer)
});

const itauOurNumberForInvoice = (invoiceId) => {
  const number = digits(invoiceId);
  if (number.length <= 16) return number.padStart(8, '0');
  const hexadecimal = createHash('sha256').update(number).digest('hex').slice(0, 13);
  return (BigInt(`0x${hexadecimal}`) % 10000000000000000n).toString().padStart(16, '0');
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
        valor_titulo: billing.amount.toFixed(2),
        texto_seu_numero: yourNumber,
        texto_uso_beneficiario: yourNumber
      }],
      codigo_especie: config.species,
      codigo_aceite: config.acceptance,
      ...(billing.issuedAt ? { data_emissao: billing.issuedAt } : {}),
      pagamento_parcial: false
    }
  };
};

const publicRecord = (record, created = false) => ({
  invoiceId: record.invoiceId,
  status: record.state,
  created,
  amount: record.amount,
  dueAt: record.dueAt,
  bank: record.bank || 'c6',
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
  if (existing?.state === 'processing' || existing?.state === 'review') {
    throw generationConflict(existing.state);
  }

  const isItau = billing.bank.id === 'itau';
  const getConfig = isItau
    ? (dependencies.itauBoletoConfig || itauBoletoConfig)
    : (dependencies.c6Config || c6Config);
  const create = isItau
    ? (dependencies.createItauBankSlip || createItauBankSlip)
    : (dependencies.createC6BankSlip || createC6BankSlip);
  const config = getConfig();
  const payload = isItau
    ? itauBankSlipPayload(billing, config)
    : bankSlipPayload(billing, config);

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
    const bankSlipId = String(bankResponse?.id || '').trim();
    if (!bankSlipId) {
      throw Object.assign(new Error(`O ${billing.bank.label} não retornou o identificador do boleto.`), {
        statusCode: 502,
        receivedResponse: true,
        ambiguousBankState: true
      });
    }
    if (isItau && (
      !bankResponse.registered ||
      digits(bankResponse.digitableLine).length < 47 ||
      digits(bankResponse.barCode).length !== 44
    )) {
      throw Object.assign(new Error(
        'O Itaú recebeu a efetivação, mas não retornou a linha digitável e o código de barras completos.'
      ), {
        statusCode: 502,
        receivedResponse: true,
        ambiguousBankState: true
      });
    }
    const itauDetail = payload?.dado_boleto?.dados_individuais_boleto?.[0] || {};
    const responseAmount = Number(bankResponse.amount);
    const readyRecord = {
      state: 'ready',
      invoiceId: billing.invoiceId,
      issuerCnpj: billing.issuerCnpj,
      bank: billing.bank.id,
      bankSlipId,
      externalReferenceId: payload.external_reference_id || itauDetail.texto_seu_numero || '',
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
      createdAt: now.toISOString()
    };
    await save(billing.invoiceId, readyRecord);
    return publicRecord(readyRecord, true);
  } catch (error) {
    if (bankResponse || error.ambiguousBankState) {
      const reviewRecord = {
        ...processingRecord,
        state: 'review',
        reviewedAt: now.toISOString()
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
  const download = dependencies.getC6BankSlipPdf || getC6BankSlipPdf;
  const config = (dependencies.c6Config || c6Config)();
  return download(record.bankSlipId, { config });
};

module.exports = {
  externalReferenceForInvoice,
  payerFromCompany,
  issuerFromInvoice,
  resolveInvoiceBillingData,
  bankSlipPayload,
  itauOurNumberForInvoice,
  itauBankSlipPayload,
  generateInvoiceBankSlip,
  getInvoiceBankSlipPdf
};
