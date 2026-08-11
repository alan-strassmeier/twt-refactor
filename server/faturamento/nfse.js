const { DOMParser } = require('@xmldom/xmldom');
const { normalizeInvoice } = require('./brudam');
const { requestExactInvoice, fetchCompany } = require('./invoice-pdf');
const { findDoccobForInvoice } = require('./r2-doccob');
const { TWT_ISSUER_CNPJ, isTwtIssuer } = require('./billing-rules');
const { nfseConfig } = require('./nfse-config');
const { buildDpsXml, signDpsXml } = require('./nfse-xml');
const { postDps, getDps } = require('./nfse-client');
const store = require('./nfse-store');
const storage = require('./nfse-storage');

const FISCAL_STANDARD = Object.freeze({
  issuerCnpj: TWT_ISSUER_CNPJ,
  municipalityCode: '4314902',
  municipalityName: 'Porto Alegre',
  serviceCode: '150603',
  serviceLabel: 'Coleta e entrega de documentos, bens e valores.',
  nbsCode: '106081000',
  nbsLabel: 'Serviços de coleta e entrega de cargas no transporte multimodal',
  totalTaxPercentage: 5.97,
  issRetention: 'Não retido'
});

const digits = (value) => String(value || '').replace(/\D/g, '');
const firstValue = (object, keys) => {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
};
const dateOnly = (value) => String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || '';
const validInvoiceId = (value) => /^\d{1,20}$/.test(String(value || '')) && Number(value) > 0;
const validationError = (message) => Object.assign(new Error(message), { statusCode: 422 });

const invoiceIssuerCnpj = (invoice, doccob) => digits(
  doccob?.invoice?.issuerCnpj ||
  firstValue(invoice, ['cnpj_emitente', 'cnpj_empresa', 'emitente_cnpj']) ||
  invoice?.emitente?.cnpj
);

const clientFromCompany = (company, fallback = {}) => {
  const client = {
    document: digits(firstValue(company, ['cnpj', 'cpf_cnpj', 'documento']) || fallback.document),
    name: String(
      firstValue(company, ['razao', 'razao_social', 'xNome', 'fantasia']) || fallback.name || ''
    ).trim(),
    municipalityCode: digits(firstValue(company, ['codigo_ibge', 'cMun', 'ibge'])),
    zipCode: digits(firstValue(company, ['cep', 'CEP'])),
    street: String(firstValue(company, ['endereco', 'logradouro', 'xLgr']) || '').trim(),
    number: String(firstValue(company, ['numero', 'nro']) || '').trim(),
    complement: String(firstValue(company, ['complemento', 'xCpl']) || '').trim(),
    district: String(firstValue(company, ['bairro', 'xBairro']) || '').trim()
  };
  if (client.document.length !== 14) throw validationError('CNPJ do tomador não está completo.');
  if (!client.name) throw validationError('Razão social do tomador não está preenchida.');
  if (client.municipalityCode.length !== 7 || client.zipCode.length !== 8 ||
      !client.street || !client.number || !client.district) {
    throw validationError(
      'O cadastro do tomador precisa ter logradouro, número, bairro, CEP e código IBGE do município.'
    );
  }
  return client;
};

const resolveInvoiceNfseData = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const requestInvoice = dependencies.requestExactInvoice || requestExactInvoice;
  const findDoccob = dependencies.findDoccobForInvoice || findDoccobForInvoice;
  const getCompany = dependencies.fetchCompany || fetchCompany;
  const { invoice } = await requestInvoice(invoiceId);
  const normalized = normalizeInvoice(invoice);
  const normalizedInvoiceId = String(normalized.id || invoiceId);
  const clientDocument = digits(normalized.clientDocument);
  let doccob = null;
  try {
    doccob = await findDoccob({
      invoiceId: normalizedInvoiceId,
      clientCnpj: clientDocument
    });
  } catch (error) {
    throw Object.assign(new Error('Não foi possível confirmar o emitente da fatura no DOCCOB.'), {
      statusCode: 503,
      expose: true,
      cause: error
    });
  }
  const issuerCnpj = invoiceIssuerCnpj(invoice, doccob);
  if (!isTwtIssuer(issuerCnpj)) {
    throw Object.assign(new Error('A emissão de NFS-e está disponível somente para faturas da TWT.'), {
      statusCode: 403
    });
  }
  if (normalized.status === 2 || String(normalized.statusLabel || '').toLowerCase().startsWith('cancel')) {
    throw validationError('Não é possível emitir NFS-e para uma fatura cancelada.');
  }
  const competence = dateOnly(normalized.issuedAt || doccob?.invoice?.issuedAt);
  if (!competence) throw validationError('A fatura não possui data de emissão válida.');
  const amount = Number(normalized.total ?? doccob?.invoice?.total);
  if (!Number.isFinite(amount) || amount <= 0) throw validationError('A fatura não possui valor total válido.');
  if (clientDocument.length !== 14) throw validationError('CNPJ do tomador não está completo.');
  const company = await getCompany(clientDocument);
  if (!company) throw validationError('Cadastro do tomador não encontrado na Brudam.');
  const client = clientFromCompany(company, {
    document: clientDocument,
    name: normalized.client
  });
  return {
    invoice: {
      id: normalizedInvoiceId,
      competence,
      amount: Number(amount.toFixed(2)),
      description: `SERVICOS DE DISTRIBUICAO CONF FAT ${normalizedInvoiceId}`
    },
    client,
    issuerCnpj,
    fiscal: FISCAL_STANDARD
  };
};

const publicPreview = (data, record = null) => ({
  invoiceId: data.invoice.id,
  competence: data.invoice.competence,
  amount: data.invoice.amount,
  description: data.invoice.description,
  client: {
    name: data.client.name,
    document: data.client.document,
    municipalityCode: data.client.municipalityCode
  },
  service: {
    code: FISCAL_STANDARD.serviceCode,
    label: FISCAL_STANDARD.serviceLabel,
    nbsCode: FISCAL_STANDARD.nbsCode,
    nbsLabel: FISCAL_STANDARD.nbsLabel,
    municipalityCode: FISCAL_STANDARD.municipalityCode,
    municipalityName: FISCAL_STANDARD.municipalityName,
    issRetention: FISCAL_STANDARD.issRetention,
    totalTaxPercentage: FISCAL_STANDARD.totalTaxPercentage
  },
  status: record?.state || 'not_issued',
  accessKey: record?.accessKey || '',
  nfseNumber: record?.nfseNumber || '',
  issuedAt: record?.processedAt || ''
});

const previewInvoiceNfse = async (invoiceId, dependencies = {}) => {
  const data = await resolveInvoiceNfseData(invoiceId, dependencies);
  const getRecord = dependencies.getNfseRecord || store.getNfseRecord;
  const record = await getRecord(data.invoice.id);
  return publicPreview(data, record);
};

const textFromElement = (document, name) => {
  const nodes = Array.from(document.getElementsByTagName('*'));
  const node = nodes.find((item) => item.localName === name);
  return node ? String(node.textContent || '').trim() : '';
};

const metadataFromAuthorizedXml = (xml, fallback = {}) => {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  const info = Array.from(document.getElementsByTagName('*'))
    .find((item) => item.localName === 'infNFSe');
  const identifier = String(info?.getAttribute?.('Id') || '');
  const accessKey = digits(fallback.accessKey || identifier.replace(/^NFS/i, ''));
  if (root?.localName !== 'NFSe' || accessKey.length !== 50) {
    throw Object.assign(new Error('A NFS-e autorizada não contém uma chave de acesso válida.'), {
      statusCode: 502,
      receivedResponse: true
    });
  }
  return {
    accessKey,
    nfseNumber: textFromElement(document, 'nNFSe'),
    processedAt: textFromElement(document, 'dhProc') || new Date().toISOString(),
    dpsNumber: textFromElement(document, 'nDPS'),
    dpsSeries: textFromElement(document, 'serie')
  };
};

const publicResult = (record, created = false) => ({
  invoiceId: record.invoiceId,
  status: record.state,
  created,
  accessKey: record.accessKey || '',
  nfseNumber: record.nfseNumber || '',
  competence: record.competence,
  amount: record.amount,
  message: record.lastError || '',
  pdfUrl: record.state === 'issued'
    ? `/api/faturamento/nfse-pdf?id=${encodeURIComponent(record.invoiceId)}`
    : '',
  xmlUrl: record.state === 'issued'
    ? `/api/faturamento/nfse-xml?id=${encodeURIComponent(record.invoiceId)}`
    : ''
});

const getInvoiceNfseStatus = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const getRecord = dependencies.getNfseRecord || store.getNfseRecord;
  const record = await getRecord(String(invoiceId));
  return record
    ? publicResult(record, false)
    : { invoiceId: String(invoiceId), status: 'not_issued', created: false };
};

const finalizeAuthorizedDocument = async ({ record, response, xml }, dependencies = {}) => {
  const saveXml = dependencies.saveNfseXml || storage.saveNfseXml;
  const saveRecord = dependencies.saveNfseRecord || store.saveNfseRecord;
  const metadata = metadataFromAuthorizedXml(xml, { accessKey: response?.chaveAcesso });
  try {
    const xmlObjectKey = await saveXml({
      invoiceId: record.invoiceId,
      accessKey: metadata.accessKey,
      processedAt: metadata.processedAt,
      xml
    });
    const issuedRecord = {
      ...record,
      ...metadata,
      state: 'issued',
      xmlObjectKey,
      alerts: Array.isArray(response?.alertas) ? response.alertas.slice(0, 20) : [],
      issuedAt: new Date().toISOString()
    };
    delete issuedRecord.authorizedXmlBase64;
    await saveRecord(record.invoiceId, issuedRecord);
    return issuedRecord;
  } catch (error) {
    const reviewRecord = {
      ...record,
      ...metadata,
      state: 'review',
      authorizedXmlBase64: Buffer.from(xml, 'utf8').toString('base64'),
      reviewReason: 'storage',
      reviewedAt: new Date().toISOString()
    };
    try { await saveRecord(record.invoiceId, reviewRecord); } catch { /* mantém o registro anterior */ }
    throw Object.assign(new Error('A NFS-e foi autorizada, mas o XML precisa ser armazenado antes da liberação.'), {
      statusCode: 503,
      expose: true,
      cause: error
    });
  }
};

const recoverExisting = async (record, config, dependencies = {}) => {
  if (record.state === 'issued') return record;
  if (record.authorizedXmlBase64) {
    return finalizeAuthorizedDocument({
      record,
      response: { chaveAcesso: record.accessKey },
      xml: Buffer.from(record.authorizedXmlBase64, 'base64').toString('utf8')
    }, dependencies);
  }
  if (!record.dpsId) return null;
  const queryDps = dependencies.getDps || getDps;
  const recovered = await queryDps(record.dpsId, { config });
  if (!recovered) return null;
  return finalizeAuthorizedDocument({ record, response: recovered, xml: recovered.xml }, dependencies);
};

const generationConflict = () => Object.assign(new Error(
  'Existe uma emissão em conferência para esta fatura. O sistema não criará outra DPS para evitar nota duplicada.'
), { statusCode: 409 });

const issueInvoiceNfse = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const config = dependencies.config || nfseConfig();
  const getRecord = dependencies.getNfseRecord || store.getNfseRecord;
  const claim = dependencies.claimNfse || store.claimNfse;
  const saveRecord = dependencies.saveNfseRecord || store.saveNfseRecord;
  const release = dependencies.releaseNfseClaim || store.releaseNfseClaim;
  const reserveNumber = dependencies.reserveDpsNumber || store.reserveDpsNumber;
  const enqueueJob = dependencies.enqueueNfseJob || store.enqueueNfseJob;
  const submitDps = dependencies.postDps || postDps;
  const data = await resolveInvoiceNfseData(invoiceId, dependencies);
  const existing = await getRecord(data.invoice.id);
  if (existing?.state === 'issued') return publicResult(existing, false);
  if (config.certificateMode === 'agent' &&
      existing && ['queued', 'agent_processing'].includes(existing.state)) {
    return publicResult(existing, false);
  }
  if (config.certificateMode === 'agent' && existing?.state === 'review') {
    if (existing.authorizedXmlBase64) {
      const recovered = await recoverExisting(existing, config, dependencies);
      if (recovered) return publicResult(recovered, false);
    }
    const recoveryRecord = {
      ...existing,
      state: 'queued',
      jobAction: 'recover',
      queuedAt: new Date().toISOString()
    };
    await saveRecord(data.invoice.id, recoveryRecord);
    await enqueueJob(recoveryRecord);
    return publicResult(recoveryRecord, false);
  }
  if (existing && ['processing', 'review'].includes(existing.state)) {
    const recovered = await recoverExisting(existing, config, dependencies);
    if (recovered) return publicResult(recovered, false);
    throw generationConflict();
  }
  if (existing?.state === 'failed') {
    await release(data.invoice.id);
  }

  const claimRecord = {
    state: 'claimed',
    invoiceId: data.invoice.id,
    issuerCnpj: data.issuerCnpj,
    competence: data.invoice.competence,
    amount: data.invoice.amount,
    claimedAt: new Date().toISOString()
  };
  const claimed = await claim(data.invoice.id, claimRecord);
  if (!claimed) {
    const concurrent = await getRecord(data.invoice.id);
    if (concurrent?.state === 'issued') return publicResult(concurrent, false);
    throw generationConflict();
  }

  let processingRecord = claimRecord;
  try {
    const dpsNumber = await reserveNumber({
      environment: config.environment,
      issuerCnpj: data.issuerCnpj,
      series: config.series,
      initialNumber: config.initialNumber
    });
    const fiscal = {
      ...FISCAL_STANDARD,
      environmentType: config.environmentType,
      series: config.series,
      applicationVersion: config.applicationVersion,
      providerPhone: config.providerPhone,
      providerEmail: config.providerEmail
    };
    const built = buildDpsXml({
      fiscal,
      client: data.client,
      invoice: data.invoice,
      dpsNumber,
      issuedAt: dependencies.now || new Date()
    });
    if (config.certificateMode === 'agent') {
      processingRecord = {
        ...claimRecord,
        state: 'queued',
        jobAction: 'issue',
        dpsId: built.dpsId,
        dpsNumber,
        dpsSeries: config.series,
        environment: config.environment,
        unsignedDpsBase64: Buffer.from(built.xml, 'utf8').toString('base64'),
        queuedAt: new Date().toISOString()
      };
      await saveRecord(data.invoice.id, processingRecord);
      await enqueueJob(processingRecord);
      return publicResult(processingRecord, true);
    }
    const signedXml = signDpsXml(built.xml, config);
    processingRecord = {
      ...claimRecord,
      state: 'processing',
      dpsId: built.dpsId,
      dpsNumber,
      dpsSeries: config.series,
      environment: config.environment,
      startedAt: new Date().toISOString()
    };
    await saveRecord(data.invoice.id, processingRecord);
    const response = await submitDps(signedXml, { config });
    const issued = await finalizeAuthorizedDocument({
      record: processingRecord,
      response,
      xml: response.xml
    }, dependencies);
    return publicResult(issued, true);
  } catch (error) {
    if (error.ambiguousNfseState) {
      const reviewRecord = {
        ...processingRecord,
        state: 'review',
        reviewReason: 'upstream',
        reviewedAt: new Date().toISOString()
      };
      try { await saveRecord(data.invoice.id, reviewRecord); } catch { /* mantém processing */ }
    } else if (['claimed', 'queued'].includes(processingRecord.state) ||
        error.receivedResponse === true) {
      try { await release(data.invoice.id); } catch { /* o lock original expira */ }
    }
    throw error;
  }
};

const getIssuedNfseXml = async (invoiceId, dependencies = {}) => {
  if (!validInvoiceId(invoiceId)) throw validationError('Número da fatura inválido.');
  const getRecord = dependencies.getNfseRecord || store.getNfseRecord;
  const getXml = dependencies.getNfseXml || storage.getNfseXml;
  const record = await getRecord(String(invoiceId));
  if (!record || record.state !== 'issued') {
    throw Object.assign(new Error('Nenhuma NFS-e foi emitida para esta fatura.'), { statusCode: 404 });
  }
  return { record, xml: await getXml(record) };
};

module.exports = {
  FISCAL_STANDARD,
  invoiceIssuerCnpj,
  clientFromCompany,
  resolveInvoiceNfseData,
  publicPreview,
  previewInvoiceNfse,
  metadataFromAuthorizedXml,
  publicResult,
  finalizeAuthorizedDocument,
  recoverExisting,
  getInvoiceNfseStatus,
  issueInvoiceNfse,
  getIssuedNfseXml
};
