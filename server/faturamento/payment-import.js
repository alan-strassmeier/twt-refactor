const { randomUUID } = require('node:crypto');
const { parsePaymentXlsx } = require('./payment-import-xlsx');
const { findDoccobInvoicesByTransportReferences } = require('./r2-doccob');
const { fetchInvoices, authenticatedPost } = require('./brudam');
const store = require('./cobranca-store');
const { DSL_TED_DOC_LIQUIDATION } = require('./billing-rules');

const APPROVAL_EVENTS = ['initial', 'reminder', 'overdue'];
const FETCH_CONCURRENCY = 4;

const digits = (value) => String(value || '').replace(/\D/g, '');
const cents = (value) => Math.round(Number(value || 0) * 100);

const validIsoDate = (value) => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
};

const positiveInteger = (value, label) => {
  const text = String(value ?? '').trim();
  const number = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw Object.assign(new Error(`${label} deve ser um número inteiro maior que zero.`), { statusCode: 422 });
  }
  return number;
};

const isWhiteMartinsCategory = (category) =>
  digits(category?.cnpj).length === 14 && category?.whiteMartins === true;

const paymentSettings = (input = {}) => {
  const paymentDate = String(input.paymentDate || '').trim();
  if (!validIsoDate(paymentDate)) {
    throw Object.assign(new Error('Informe uma data de pagamento válida.'), { statusCode: 422 });
  }
  return {
    paymentDate,
    paymentMethodId: DSL_TED_DOC_LIQUIDATION.paymentMethodId,
    bankAccountId: DSL_TED_DOC_LIQUIDATION.bankAccountId
  };
};

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const exactInvoice = async (invoiceId, clientCnpj, fetcher = fetchInvoices) => {
  const result = await fetcher({ id: invoiceId, cnpj: clientCnpj, limit: 100, skip: 0 });
  return (result?.invoices || []).find((invoice) => String(invoice.id) === String(invoiceId)) || null;
};

const rowMatch = (row, matches) => {
  const byReference = matches.filter((match) => match.reference === row.cteNumber);
  let candidates = byReference;
  if (row.supplierTaxId) {
    const byIssuer = candidates.filter((match) =>
      !match.invoice?.issuerCnpj || digits(match.invoice.issuerCnpj) === row.supplierTaxId);
    if (byIssuer.length) candidates = byIssuer;
    else if (candidates.some((match) => digits(match.invoice?.issuerCnpj))) {
      return { error: 'O emitente do DOCCOB diverge do CNPJ informado na planilha.' };
    }
  }
  if (row.dueAt) {
    const byDueDate = candidates.filter((match) =>
      !match.invoice?.dueAt || match.invoice.dueAt === row.dueAt);
    if (byDueDate.length) candidates = byDueDate;
    else if (candidates.some((match) => match.invoice?.dueAt)) {
      return { error: 'O vencimento da planilha diverge da fatura no DOCCOB.' };
    }
  }
  const unique = new Map(candidates.map((match) => [
    `${match.invoiceId}:${match.clientCnpj}`,
    match
  ]));
  if (unique.size === 1) return { match: [...unique.values()][0] };
  if (unique.size > 1) return { error: 'O CT-e foi localizado em mais de uma fatura White Martins.' };
  return { error: 'CT-e não localizado nos DOCCOBs das empresas White Martins.' };
};

const candidateFromGroup = (group, invoice) => {
  const importedReferences = new Set(group.rows.map((row) => row.cteNumber));
  const expectedReferences = new Set(group.match.transportReferences || []);
  const missingReferences = [...expectedReferences].filter((reference) => !importedReferences.has(reference));
  const importedAmount = Math.round(group.rows.reduce((total, row) => total + row.amount, 0) * 100) / 100;
  const invoiceBalance = invoice ? Number(invoice.balance) : null;
  let reason = '';
  if (!invoice) reason = 'Fatura não encontrada na Brudam.';
  else if (Number(invoice.status) !== 0 || cents(invoiceBalance) <= 0) reason = 'A fatura não está em aberto na Brudam.';
  else if (digits(invoice.clientDocument) !== group.match.clientCnpj) reason = 'O CNPJ da fatura diverge do DOCCOB.';
  else if (missingReferences.length) reason = `Faltam ${missingReferences.length} CT-e(s) desta fatura na planilha.`;
  else if (cents(importedAmount) !== cents(invoiceBalance)) reason = 'O valor importado difere do saldo atual da fatura.';
  else if (!Number.isSafeInteger(Number(invoice.internalId)) || Number(invoice.internalId) <= 0) {
    reason = 'A Brudam não retornou o identificador interno do lançamento.';
  }
  return {
    invoiceId: String(group.match.invoiceId),
    internalId: invoice?.internalId ? Number(invoice.internalId) : null,
    clientCnpj: group.match.clientCnpj,
    clientName: invoice?.client || 'Não informado',
    dueAt: invoice?.dueAt || group.match.invoice?.dueAt || '',
    references: [...importedReferences].sort((left, right) => left.localeCompare(right, 'pt-BR', { numeric: true })),
    sourceRows: group.rows.map((row) => row.row),
    importedAmount,
    invoiceTotal: invoice?.total ?? null,
    balance: invoiceBalance,
    status: reason ? 'blocked' : 'ready',
    eligible: !reason,
    reason,
    approvedAt: null,
    liquidationIds: []
  };
};

const analyzePaymentImport = async (input, dependencies = {}) => {
  const settings = paymentSettings(input);
  const filename = String(input.filename || '').trim().slice(0, 180);
  if (!/\.xlsx$/i.test(filename)) {
    throw Object.assign(new Error('Selecione um arquivo com extensão .xlsx.'), { statusCode: 422 });
  }
  const parseXlsx = dependencies.parseXlsx || parsePaymentXlsx;
  const parsed = parseXlsx(input.fileBase64);
  const categories = await (dependencies.listCategories || store.listCategories)();
  const whiteMartinsCategories = categories.filter(isWhiteMartinsCategory);
  if (!whiteMartinsCategories.length) {
    throw Object.assign(new Error('Nenhuma empresa White Martins está cadastrada na área de cobrança.'), { statusCode: 422 });
  }
  const duplicatedReferences = new Set();
  const seenReferences = new Set();
  parsed.rows.forEach((row) => {
    if (seenReferences.has(row.cteNumber)) duplicatedReferences.add(row.cteNumber);
    seenReferences.add(row.cteNumber);
  });
  const scanRows = parsed.rows.filter((row) => !duplicatedReferences.has(row.cteNumber));
  const matches = await (dependencies.findMatches || findDoccobInvoicesByTransportReferences)({
    references: scanRows.map((row) => row.cteNumber),
    clientCnpjs: whiteMartinsCategories.map((category) => category.cnpj)
  });
  const rejectedRows = [...parsed.errors];
  duplicatedReferences.forEach((reference) => {
    parsed.rows.filter((row) => row.cteNumber === reference).forEach((row) => rejectedRows.push({
      row: row.row,
      reference: row.reference,
      message: 'Referência duplicada na planilha.'
    }));
  });
  const groups = new Map();
  scanRows.forEach((row) => {
    const resolved = rowMatch(row, matches);
    if (!resolved.match) {
      rejectedRows.push({ row: row.row, reference: row.reference, message: resolved.error });
      return;
    }
    const key = `${resolved.match.invoiceId}:${resolved.match.clientCnpj}`;
    const group = groups.get(key) || { match: resolved.match, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  });

  const groupList = [...groups.values()];
  const invoices = await mapWithConcurrency(groupList, FETCH_CONCURRENCY, (group) =>
    exactInvoice(group.match.invoiceId, group.match.clientCnpj, dependencies.fetchInvoices || fetchInvoices));
  const candidates = groupList.map((group, index) => candidateFromGroup(group, invoices[index]));
  const createdAt = new Date().toISOString();
  const record = {
    id: randomUUID(),
    filename,
    createdAt,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    settings,
    scope: {
      company: 'White Martins',
      cnpjs: whiteMartinsCategories.map((category) => digits(category.cnpj))
    },
    summary: {
      spreadsheetRows: parsed.rows.length + parsed.errors.length,
      validRows: parsed.rows.length,
      rejectedRows: rejectedRows.length,
      invoices: candidates.length,
      eligibleInvoices: candidates.filter((candidate) => candidate.eligible).length,
      eligibleAmount: candidates.filter((candidate) => candidate.eligible)
        .reduce((total, candidate) => total + candidate.importedAmount, 0)
    },
    candidates,
    rejectedRows: rejectedRows.sort((left, right) => Number(left.row) - Number(right.row))
  };
  await (dependencies.saveImport || store.savePaymentImport)(record);
  return record;
};

const liquidationError = (result) => {
  const data = result?.payload?.data;
  const details = Array.isArray(data) ? data.filter(Boolean).join('; ') : '';
  const message = String(result?.payload?.message || '').trim();
  return Object.assign(new Error(
    [message && message.toUpperCase() !== 'OK' ? message : '', details]
      .filter(Boolean).join(': ') || 'A Brudam recusou a liquidação da fatura.'
  ), { statusCode: result?.response?.status >= 400 ? result.response.status : 502 });
};

const closeBillingForSettledInvoice = async (record, candidate, completedAt, dependencies) => {
  try {
    await Promise.all([
      (dependencies.removePending || store.removePending)(candidate.invoiceId),
      ...APPROVAL_EVENTS.map((event) =>
        (dependencies.markCompleted || store.markBillingEventCompleted)(event, candidate.invoiceId, {
          reason: 'payment_import',
          completedAt,
          importId: record.id
        }))
    ]);
  } catch (error) {
    console.error('[faturamento:pagamentos:encerramento-cobranca]', {
      invoiceId: candidate.invoiceId,
      error: error.message
    });
  }
};

const approveCandidate = async (record, candidate, dependencies = {}) => {
  const claim = dependencies.claimApproval || store.claimPaymentApproval;
  const release = dependencies.releaseApproval || store.releasePaymentApproval;
  if (!await claim(record.id, candidate.invoiceId)) {
    return { invoiceId: candidate.invoiceId, status: 'busy', message: 'Esta fatura já está sendo processada.' };
  }
  try {
    const categoryCnpjs = new Set((record.scope?.cnpjs || []).map(digits));
    if (!categoryCnpjs.has(digits(candidate.clientCnpj))) {
      throw Object.assign(new Error('A fatura não pertence a um CNPJ White Martins autorizado.'), { statusCode: 422 });
    }
    const fetcher = dependencies.fetchInvoices || fetchInvoices;
    const current = await exactInvoice(candidate.invoiceId, candidate.clientCnpj, fetcher);
    if (!current) throw Object.assign(new Error('Fatura não encontrada na Brudam.'), { statusCode: 404 });
    if (Number(current.status) === 1 || cents(current.balance) <= 0) {
      const approvedAt = new Date().toISOString();
      await closeBillingForSettledInvoice(record, candidate, approvedAt, dependencies);
      return {
        invoiceId: candidate.invoiceId,
        status: 'already_settled',
        approvedAt,
        message: 'A fatura já está liquidada.'
      };
    }
    if (Number(current.status) !== 0) {
      throw Object.assign(new Error('A fatura não está em aberto na Brudam.'), { statusCode: 409 });
    }
    if (digits(current.clientDocument) !== digits(candidate.clientCnpj)) {
      throw Object.assign(new Error('O CNPJ atual da fatura diverge da importação.'), { statusCode: 409 });
    }
    if (cents(current.balance) !== cents(candidate.importedAmount)) {
      throw Object.assign(new Error('O saldo da fatura mudou após a análise. Importe o arquivo novamente.'), { statusCode: 409 });
    }
    if (!validIsoDate(record.settings?.paymentDate)) {
      throw Object.assign(new Error('A data de pagamento da importação é inválida.'), { statusCode: 422 });
    }
    const internalId = positiveInteger(current.internalId, 'O identificador interno do lançamento');
    const request = {
      documentos: [{
        id_lancamento: internalId,
        data_pagamento: record.settings.paymentDate,
        forma_pagamento: DSL_TED_DOC_LIQUIDATION.paymentMethodId,
        data_credito_debito: record.settings.paymentDate,
        valor_juros: 0,
        valor_liquidado: candidate.importedAmount,
        conta_bancaria: DSL_TED_DOC_LIQUIDATION.bankAccountId
      }]
    };
    const result = await (dependencies.liquidate || authenticatedPost)(
      '/financeiro/liquidar/lancamento',
      request
    );
    if (!result?.response?.ok || Number(result?.payload?.status) !== 1 || Number(result?.payload?.data?.status) !== 1) {
      throw liquidationError(result);
    }
    const approvedAt = new Date().toISOString();
    await closeBillingForSettledInvoice(record, candidate, approvedAt, dependencies);
    return {
      invoiceId: candidate.invoiceId,
      status: 'liquidated',
      approvedAt,
      liquidationIds: Array.isArray(result.payload?.data?.ids) ? result.payload.data.ids : [internalId],
      message: 'Fatura liquidada na Brudam.'
    };
  } catch (error) {
    return {
      invoiceId: candidate.invoiceId,
      status: 'error',
      message: String(error.message || error).slice(0, 500)
    };
  } finally {
    try {
      await release(record.id, candidate.invoiceId);
    } catch (error) {
      console.error('[faturamento:pagamentos:liberacao]', {
        invoiceId: candidate.invoiceId,
        error: error.message
      });
    }
  }
};

const approvePaymentImport = async (input, dependencies = {}) => {
  const getImport = dependencies.getImport || store.getPaymentImport;
  const saveImport = dependencies.saveImport || store.savePaymentImport;
  const record = await getImport(input.importId);
  if (!record) throw Object.assign(new Error('A importação expirou ou não foi encontrada.'), { statusCode: 404 });
  const requested = Array.isArray(input.invoiceIds)
    ? new Set(input.invoiceIds.map((value) => String(value || '').replace(/\D/g, '')).filter(Boolean))
    : null;
  const selected = record.candidates.filter((candidate) =>
    candidate.eligible && ['ready', 'error', 'busy'].includes(candidate.status) &&
      (!requested || requested.has(candidate.invoiceId)));
  if (!selected.length) {
    throw Object.assign(new Error('Nenhuma fatura apta foi selecionada para aprovação.'), { statusCode: 422 });
  }
  const results = [];
  for (const candidate of selected) {
    const result = await approveCandidate(record, candidate, dependencies);
    results.push(result);
    Object.assign(candidate, {
      status: result.status === 'busy' ? 'error' : result.status,
      eligible: !['liquidated', 'already_settled'].includes(result.status),
      approvedAt: result.approvedAt || candidate.approvedAt,
      liquidationIds: result.liquidationIds || candidate.liquidationIds,
      reason: result.status === 'error' ? result.message : ''
    });
  }
  record.summary.eligibleInvoices = record.candidates.filter((candidate) =>
    candidate.eligible && candidate.status === 'ready').length;
  record.summary.eligibleAmount = record.candidates.filter((candidate) =>
    candidate.eligible && candidate.status === 'ready')
    .reduce((total, candidate) => total + candidate.importedAmount, 0);
  record.updatedAt = new Date().toISOString();
  await saveImport(record);
  return { import: record, results };
};

module.exports = {
  isWhiteMartinsCategory,
  paymentSettings,
  rowMatch,
  candidateFromGroup,
  analyzePaymentImport,
  approveCandidate,
  approvePaymentImport
};
