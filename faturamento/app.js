(() => {
  'use strict';

  const LIMIT = 100;
  const elements = {
    loadingPanel: document.getElementById('loadingPanel'),
    loginPanel: document.getElementById('loginPanel'),
    dashboardPanel: document.getElementById('dashboardPanel'),
    loginForm: document.getElementById('loginForm'),
    loginMessage: document.getElementById('loginMessage'),
    logoutButton: document.getElementById('logoutButton'),
    filterForm: document.getElementById('filterForm'),
    clearFilters: document.getElementById('clearFilters'),
    dashboardMessage: document.getElementById('dashboardMessage'),
    invoiceRows: document.getElementById('invoiceRows'),
    emptyState: document.getElementById('emptyState'),
    tableLoading: document.getElementById('tableLoading'),
    previousPageButtons: [...document.querySelectorAll('[data-page-action="previous"]')],
    nextPageButtons: [...document.querySelectorAll('[data-page-action="next"]')],
    pageIndicators: [...document.querySelectorAll('[data-page-indicator]')],
    resultRange: document.getElementById('resultRange'),
    invoiceCount: document.getElementById('invoiceCount'),
    totalAmount: document.getElementById('totalAmount'),
    paidAmount: document.getElementById('paidAmount'),
    balanceAmount: document.getElementById('balanceAmount'),
    invoiceCountLabel: document.getElementById('invoiceCountLabel'),
    totalAmountLabel: document.getElementById('totalAmountLabel'),
    paidAmountLabel: document.getElementById('paidAmountLabel'),
    balanceAmountLabel: document.getElementById('balanceAmountLabel'),
    viewButtons: [...document.querySelectorAll('[data-view-mode]')],
    tableView: document.getElementById('tableView'),
    chartView: document.getElementById('chartView'),
    chartContent: document.getElementById('chartContent'),
    chartEmptyState: document.getElementById('chartEmptyState'),
    chartLoading: document.getElementById('chartLoading'),
    chartResultDescription: document.getElementById('chartResultDescription'),
    debtorChart: document.getElementById('debtorChart'),
    debtorChartSegments: document.getElementById('debtorChartSegments'),
    donutWrap: document.getElementById('donutWrap'),
    chartTotalPending: document.getElementById('chartTotalPending'),
    chartLegend: document.getElementById('chartLegend'),
    chartTooltip: document.getElementById('chartTooltip'),
    chartTooltipName: document.getElementById('chartTooltipName'),
    chartTooltipPercentage: document.getElementById('chartTooltipPercentage'),
    chartTooltipValue: document.getElementById('chartTooltipValue'),
    sortHeaders: [...document.querySelectorAll('[data-sort-key]')],
    tableHeader: document.querySelector('.table-card thead'),
    backToTopButton: document.getElementById('backToTopButton'),
    documentModal: document.getElementById('documentModal'),
    documentModalBackdrop: document.getElementById('documentModalBackdrop'),
    documentModalClose: document.getElementById('documentModalClose'),
    documentModalTitle: document.getElementById('documentModalTitle'),
    invoicePdfChoice: document.getElementById('invoicePdfChoice'),
    dactePdfChoice: document.getElementById('dactePdfChoice'),
    dacteChoiceDescription: document.getElementById('dacteChoiceDescription'),
    bankSlipChoice: document.getElementById('bankSlipChoice'),
    bankSlipBankIcon: document.getElementById('bankSlipBankIcon'),
    bankSlipChoiceDescription: document.getElementById('bankSlipChoiceDescription'),
    nfseChoice: document.getElementById('nfseChoice'),
    nfseChoiceTitle: document.getElementById('nfseChoiceTitle'),
    nfseChoiceDescription: document.getElementById('nfseChoiceDescription'),
    nfseConfirmModal: document.getElementById('nfseConfirmModal'),
    nfseConfirmBackdrop: document.getElementById('nfseConfirmBackdrop'),
    nfseConfirmClose: document.getElementById('nfseConfirmClose'),
    nfseCancelButton: document.getElementById('nfseCancelButton'),
    nfseIssueButton: document.getElementById('nfseIssueButton'),
    nfsePreviewInvoice: document.getElementById('nfsePreviewInvoice'),
    nfsePreviewCompetence: document.getElementById('nfsePreviewCompetence'),
    nfsePreviewClient: document.getElementById('nfsePreviewClient'),
    nfsePreviewDocument: document.getElementById('nfsePreviewDocument'),
    nfsePreviewAmount: document.getElementById('nfsePreviewAmount'),
    nfsePreviewService: document.getElementById('nfsePreviewService'),
    nfsePreviewDescription: document.getElementById('nfsePreviewDescription'),
    nfsePreviewTaxation: document.getElementById('nfsePreviewTaxation'),
    nfseConfirmWarning: document.querySelector('.nfse-confirm-warning')
  };

  const state = {
    skip: 0,
    hasMore: false,
    loading: false,
    invoices: [],
    sortKey: 'issuedAt',
    sortDirection: 'desc',
    view: 'list',
    hasSearched: false
  };

  const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });

  const percentage = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2
  });

  const CHART_COLORS = [
    '#1976bd', '#f28e2b', '#2e9d67', '#d64f73', '#7559b8', '#00a6a6',
    '#e0ad25', '#4e79a7', '#a05a2c', '#76b7b2', '#b75d9b', '#8a9a32'
  ];

  const requestJson = async (url, options = {}) => {
    const { headers = {}, ...requestOptions } = options;
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...requestOptions,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { message: 'Resposta inválida do servidor.' };
    if (!response.ok) {
      const error = new Error(payload.message || 'Não foi possível concluir a solicitação.');
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  let scrollUpdateScheduled = false;

  const updateBackToTopVisibility = () => {
    const reference = state.view === 'debtors' ? elements.chartView : elements.tableHeader;
    const passedResultsHeader = !elements.dashboardPanel.hidden &&
      !reference.hidden && reference.getBoundingClientRect().top <= 0;
    elements.backToTopButton.hidden = !passedResultsHeader;
    scrollUpdateScheduled = false;
  };

  const scheduleBackToTopUpdate = () => {
    if (scrollUpdateScheduled) return;
    scrollUpdateScheduled = true;
    window.requestAnimationFrame(updateBackToTopVisibility);
  };

  const showPanel = (panel) => {
    elements.loadingPanel.hidden = panel !== 'loading';
    elements.loginPanel.hidden = panel !== 'login';
    elements.dashboardPanel.hidden = panel !== 'dashboard';
    elements.logoutButton.hidden = panel !== 'dashboard';
    if (panel !== 'dashboard') elements.backToTopButton.hidden = true;
    scheduleBackToTopUpdate();
  };

  const formatDate = (value) => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : value || '—';
  };

  const formatCurrency = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? currency.format(value) : '—';

  const formatCnpj = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 14
      ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
      : value || '';
  };

  const appendCell = (row, value, className = '') => {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
  };

  const statusClass = (status) => ({
    0: 'status-open',
    1: 'status-paid',
    2: 'status-cancelled'
  }[status] || 'status-unknown');

  const createPdfCell = (invoice) => {
    const cell = document.createElement('td');
    cell.className = 'visualize-cell';
    const invoiceId = String(invoice.id ?? '').trim();
    if (!invoiceId) {
      const unavailable = document.createElement('span');
      unavailable.className = 'pdf-unavailable';
      unavailable.textContent = 'Indisponível';
      cell.appendChild(unavailable);
      return cell;
    }

    const link = document.createElement('button');
    link.className = 'pdf-link';
    link.type = 'button';
    link.dataset.invoiceId = invoiceId;
    link.setAttribute('aria-label', `Visualizar documentos da fatura ${invoiceId}`);
    link.title = `Visualizar documentos da fatura ${invoiceId}`;
    const icon = document.createElement('span');
    icon.className = 'pdf-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'PDF';
    link.appendChild(icon);
    link.addEventListener('click', () => openInvoiceDocuments(invoiceId, link));
    cell.appendChild(link);
    return cell;
  };

  let modalPreviousFocus = null;

  const invoicePdfUrl = (invoiceId) =>
    `/api/faturamento/fatura-pdf?id=${encodeURIComponent(invoiceId)}`;

  const dactePdfUrl = (invoiceId) =>
    `/api/faturamento/dacte-pdf?id=${encodeURIComponent(invoiceId)}`;

  const bankSlipPdfUrl = (invoiceId) =>
    `/api/faturamento/boleto-pdf?id=${encodeURIComponent(invoiceId)}`;

  const nfsePdfUrl = (invoiceId) =>
    `/api/faturamento/nfse-pdf?id=${encodeURIComponent(invoiceId)}`;

  const nfsePendingStates = new Set(['queued', 'agent_processing']);

  const closeDocumentModal = () => {
    if (elements.documentModal.hidden) return;
    elements.documentModal.hidden = true;
    document.body.classList.remove('modal-open');
    modalPreviousFocus?.focus();
    modalPreviousFocus = null;
  };

  const closeNfseConfirm = (returnToDocuments = true) => {
    if (elements.nfseConfirmModal.hidden) return;
    elements.nfseConfirmModal.hidden = true;
    if (returnToDocuments) {
      elements.documentModal.hidden = false;
      elements.documentModalClose.focus();
      return;
    }
    document.body.classList.remove('modal-open');
    modalPreviousFocus?.focus();
    modalPreviousFocus = null;
  };

  const closeAllDocumentModals = () => {
    elements.nfseConfirmModal.hidden = true;
    elements.documentModal.hidden = true;
    document.body.classList.remove('modal-open');
    modalPreviousFocus?.focus();
    modalPreviousFocus = null;
  };

  const showDocumentModal = (invoiceId, options, trigger) => {
    const cteCount = Number(options.cteCount) || 0;
    modalPreviousFocus = trigger;
    elements.documentModalTitle.textContent = `Documentos da fatura ${invoiceId}`;
    elements.invoicePdfChoice.href = invoicePdfUrl(invoiceId);
    elements.dactePdfChoice.href = dactePdfUrl(invoiceId);
    elements.dactePdfChoice.hidden = !options.hasCte;
    elements.dacteChoiceDescription.textContent = cteCount === 1
      ? 'Documento do CT-e vinculado'
      : `${cteCount} DACTEs em um único PDF`;
    elements.bankSlipChoice.hidden = !options.bankSlipEligible;
    elements.bankSlipChoice.dataset.invoiceId = options.bankSlipEligible ? invoiceId : '';
    const bankLabel = String(options.bankSlipBankLabel || 'Banco');
    elements.bankSlipChoice.dataset.bankLabel = bankLabel;
    elements.bankSlipBankIcon.textContent = bankLabel;
    elements.bankSlipChoice.disabled = false;
    elements.bankSlipChoice.classList.remove('is-loading');
    elements.bankSlipChoiceDescription.textContent = `Cobrança emitida exclusivamente pelo ${bankLabel}`;
    elements.nfseChoice.hidden = !options.nfseEligible;
    elements.nfseChoice.dataset.invoiceId = options.nfseEligible ? invoiceId : '';
    elements.nfseChoice.dataset.status = options.nfseStatus || 'not_issued';
    elements.nfseChoice.disabled = false;
    elements.nfseChoice.classList.remove('is-loading');
    if (options.nfseStatus === 'issued') {
      elements.nfseChoiceTitle.textContent = 'Visualizar NFS-e';
      elements.nfseChoiceDescription.textContent = options.nfseNumber
        ? `NFS-e nº ${options.nfseNumber} emitida para esta fatura`
        : 'NFS-e emitida para esta fatura';
    } else if (nfsePendingStates.has(options.nfseStatus)) {
      elements.nfseChoiceTitle.textContent = 'Acompanhar emissão da NFS-e';
      elements.nfseChoiceDescription.textContent = options.nfseStatus === 'agent_processing'
        ? 'O agente A3 está assinando e transmitindo a DPS'
        : 'A DPS está aguardando o computador com o certificado A3';
    } else if (['processing', 'review'].includes(options.nfseStatus)) {
      elements.nfseChoiceTitle.textContent = 'Conferir emissão da NFS-e';
      elements.nfseChoiceDescription.textContent = 'Existe uma DPS em processamento ou revisão';
    } else if (options.nfseStatus === 'failed') {
      elements.nfseChoiceTitle.textContent = 'Tentar gerar NFS-e novamente';
      elements.nfseChoiceDescription.textContent = 'A última tentativa não foi autorizada';
    } else {
      elements.nfseChoiceTitle.textContent = 'Gerar NFS-e';
      elements.nfseChoiceDescription.textContent = 'Nota fiscal de serviço exclusiva da TWT';
    }
    elements.documentModal.hidden = false;
    document.body.classList.add('modal-open');
    elements.documentModalClose.focus();
  };

  const openPdfAfterCheck = (url, reservedTab = null) => {
    if (reservedTab && !reservedTab.closed) {
      reservedTab.location.replace(url);
      return true;
    }
    const tab = window.open(url, '_blank');
    if (tab) {
      tab.opener = null;
      return true;
    }
    elements.dashboardMessage.textContent =
      'O PDF está pronto, mas o navegador bloqueou a nova guia. Permita pop-ups para este site e clique novamente em Visualizar.';
    return false;
  };

  const reserveNfseTab = () => {
    const tab = window.open('', '_blank');
    if (!tab) return null;
    tab.opener = null;
    tab.document.title = 'Gerando NFS-e';
    tab.document.body.style.cssText =
      'margin:0;min-height:100vh;display:grid;place-items:center;font:600 16px system-ui,sans-serif;color:#15334a;background:#f4f8fb';
    const message = tab.document.createElement('p');
    message.textContent = 'Gerando NFS-e. Aguarde…';
    tab.document.body.appendChild(message);
    return tab;
  };

  const generateBankSlip = async () => {
    const invoiceId = String(elements.bankSlipChoice.dataset.invoiceId || '');
    const bankLabel = String(elements.bankSlipChoice.dataset.bankLabel || 'banco');
    if (!invoiceId || elements.bankSlipChoice.disabled) return;
    const confirmed = window.confirm(
      `Confirma a geração do boleto ${bankLabel} para a fatura ${invoiceId}? Se ele já existir, será apenas aberto.`
    );
    if (!confirmed) return;
    elements.bankSlipChoice.disabled = true;
    elements.bankSlipChoice.classList.add('is-loading');
    elements.bankSlipChoice.setAttribute('aria-busy', 'true');
    elements.bankSlipChoiceDescription.textContent = `Gerando e registrando o boleto no ${bankLabel}…`;
    elements.dashboardMessage.textContent = '';
    try {
      const payload = await requestJson('/api/faturamento/boleto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId })
      });
      if (payload.status === 'validated') {
        elements.dashboardMessage.textContent = payload.message ||
          'Dados validados pelo Itaú. Nenhum boleto foi registrado.';
        elements.bankSlipChoiceDescription.textContent = elements.dashboardMessage.textContent;
        return;
      }
      closeDocumentModal();
      openPdfAfterCheck(payload.pdfUrl || bankSlipPdfUrl(invoiceId));
    } catch (error) {
      if (error.status === 401) {
        closeDocumentModal();
        showPanel('login');
        elements.loginMessage.textContent = 'Sua sessão expirou. Entre novamente.';
      } else {
        elements.dashboardMessage.textContent = error.message;
        elements.bankSlipChoiceDescription.textContent = error.message;
      }
    } finally {
      elements.bankSlipChoice.disabled = false;
      elements.bankSlipChoice.classList.remove('is-loading');
      elements.bankSlipChoice.removeAttribute('aria-busy');
    }
  };

  const showNfsePreview = (payload) => {
    elements.nfsePreviewInvoice.textContent = payload.invoiceId || '—';
    elements.nfsePreviewCompetence.textContent = formatDate(payload.competence);
    elements.nfsePreviewClient.textContent = payload.client?.name || '—';
    elements.nfsePreviewDocument.textContent = formatCnpj(payload.client?.document);
    elements.nfsePreviewAmount.textContent = formatCurrency(Number(payload.amount));
    elements.nfsePreviewService.textContent = [
      payload.service?.code,
      payload.service?.nbsCode
    ].filter(Boolean).join(' / ') || '—';
    elements.nfsePreviewDescription.textContent = payload.description || '—';
    elements.nfsePreviewTaxation.textContent = [
      `ISSQN ${payload.service?.issRetention || '—'}`,
      `Simples Nacional (${payload.service?.totalTaxPercentage ?? '—'}% de tributos aproximados)`,
      `${payload.service?.municipalityName || 'Porto Alegre'} / RS`
    ].join(' • ');
    elements.nfseConfirmWarning.textContent = payload.environment === 'homologation'
      ? 'ATENÇÃO: ambiente de homologação. O documento gerado não possui valor fiscal.'
      : nfsePendingStates.has(payload.status)
      ? 'A solicitação está aguardando o computador da TWT com o certificado A3 conectado.'
      : payload.status === 'review'
        ? 'A transmissão anterior precisa ser consultada antes de qualquer nova emissão.'
        : payload.message ||
          'A emissão é exclusiva para a TWT e usa o padrão fiscal aprovado para a fatura.';
    elements.nfseIssueButton.dataset.invoiceId = payload.invoiceId || '';
    elements.nfseIssueButton.textContent = nfsePendingStates.has(payload.status)
      ? 'Atualizar situação'
      : ['processing', 'review'].includes(payload.status)
        ? 'Conferir emissão'
        : payload.environment === 'homologation'
          ? 'Confirmar teste'
          : 'Confirmar e emitir';
    elements.documentModal.hidden = true;
    elements.nfseConfirmModal.hidden = false;
    elements.nfseIssueButton.focus();
  };

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const followAgentNfse = async (invoiceId, initialPayload) => {
    let payload = initialPayload;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (payload.status === 'issued') return payload;
      if (payload.status === 'failed') {
        throw new Error(payload.message || 'A DPS não foi autorizada. Confira o agente A3.');
      }
      if (payload.status === 'review') {
        elements.nfseConfirmWarning.textContent =
          'A transmissão ficou inconclusiva. Use “Conferir emissão” para consultar a DPS sem duplicá-la.';
        elements.nfseIssueButton.textContent = 'Conferir emissão';
        return payload;
      }
      elements.nfseConfirmWarning.textContent = payload.status === 'agent_processing'
        ? 'O agente A3 está assinando e transmitindo a DPS. Aguarde…'
        : 'Aguardando o computador emissor com o token A3 conectado…';
      if (elements.nfseConfirmModal.hidden) return payload;
      await wait(3000);
      payload = await requestJson(
        `/api/faturamento/nfse?id=${encodeURIComponent(invoiceId)}&status=1`
      );
    }
    elements.nfseConfirmWarning.textContent =
      'A solicitação continua na fila. Você pode fechar esta janela e consultar novamente depois.';
    return payload;
  };

  const prepareNfse = async () => {
    const invoiceId = String(elements.nfseChoice.dataset.invoiceId || '');
    if (!invoiceId || elements.nfseChoice.disabled) return;
    if (elements.nfseChoice.dataset.status === 'issued') {
      closeDocumentModal();
      openPdfAfterCheck(nfsePdfUrl(invoiceId));
      return;
    }
    elements.nfseChoice.disabled = true;
    elements.nfseChoice.classList.add('is-loading');
    elements.nfseChoice.setAttribute('aria-busy', 'true');
    elements.nfseChoiceDescription.textContent = 'Carregando e validando os dados fiscais…';
    elements.dashboardMessage.textContent = '';
    try {
      const payload = await requestJson(
        `/api/faturamento/nfse?id=${encodeURIComponent(invoiceId)}`
      );
      if (payload.status === 'issued') {
        closeDocumentModal();
        openPdfAfterCheck(nfsePdfUrl(invoiceId));
        return;
      }
      showNfsePreview(payload);
    } catch (error) {
      if (error.status === 401) {
        closeAllDocumentModals();
        showPanel('login');
        elements.loginMessage.textContent = 'Sua sessão expirou. Entre novamente.';
      } else {
        elements.dashboardMessage.textContent = error.message;
        elements.nfseChoiceDescription.textContent = error.message;
      }
    } finally {
      elements.nfseChoice.disabled = false;
      elements.nfseChoice.classList.remove('is-loading');
      elements.nfseChoice.removeAttribute('aria-busy');
    }
  };

  const issueNfse = async () => {
    const invoiceId = String(elements.nfseIssueButton.dataset.invoiceId || '');
    if (!invoiceId || elements.nfseIssueButton.disabled) return;
    const nfseTab = reserveNfseTab();
    let nfseTabUsed = false;
    elements.nfseIssueButton.disabled = true;
    elements.nfseCancelButton.disabled = true;
    elements.nfseIssueButton.textContent = 'Emitindo…';
    elements.nfseConfirmWarning.textContent =
      'Aguarde. Não feche esta janela nem repita a solicitação enquanto a DPS é processada.';
    try {
      const payload = await requestJson('/api/faturamento/nfse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, confirmed: true })
      });
      let result = payload;
      if (nfsePendingStates.has(payload.status)) {
        elements.nfseCancelButton.disabled = false;
        result = await followAgentNfse(invoiceId, payload);
      }
      if (result.status === 'issued') {
        closeNfseConfirm(false);
        nfseTabUsed = openPdfAfterCheck(
          result.pdfUrl || nfsePdfUrl(invoiceId),
          nfseTab
        );
      }
    } catch (error) {
      if (error.status === 401) {
        closeAllDocumentModals();
        showPanel('login');
        elements.loginMessage.textContent = 'Sua sessão expirou. Entre novamente.';
      } else {
        elements.nfseConfirmWarning.textContent = error.message;
        elements.dashboardMessage.textContent = error.message;
      }
    } finally {
      if (!nfseTabUsed && nfseTab && !nfseTab.closed) nfseTab.close();
      elements.nfseIssueButton.disabled = false;
      elements.nfseCancelButton.disabled = false;
      if (!elements.nfseConfirmModal.hidden) {
        elements.nfseIssueButton.textContent = 'Atualizar situação';
      } else {
        elements.nfseIssueButton.textContent = 'Confirmar e emitir';
      }
    }
  };

  const openInvoiceDocuments = async (invoiceId, trigger) => {
    if (trigger.disabled) return;
    const originalTitle = trigger.title;
    trigger.disabled = true;
    trigger.classList.add('is-loading');
    trigger.setAttribute('aria-busy', 'true');
    trigger.title = 'Conferindo documentos da fatura…';
    elements.dashboardMessage.textContent = '';
    try {
      const payload = await requestJson(
        `/api/faturamento/documentos?id=${encodeURIComponent(invoiceId)}`
      );
      if (payload.hasCte || payload.bankSlipEligible || payload.nfseEligible) {
        showDocumentModal(invoiceId, {
          hasCte: Boolean(payload.hasCte),
          cteCount: Number(payload.cteCount) || 0,
          bankSlipEligible: Boolean(payload.bankSlipEligible),
          bankSlipBankLabel: payload.bankSlipBankLabel,
          nfseEligible: Boolean(payload.nfseEligible),
          nfseStatus: payload.nfseStatus,
          nfseNumber: payload.nfseNumber
        }, trigger);
      } else {
        openPdfAfterCheck(invoicePdfUrl(invoiceId));
      }
    } catch (error) {
      if (error.status === 401) {
        showPanel('login');
        elements.loginMessage.textContent = 'Sua sessão expirou. Entre novamente.';
      } else {
        elements.dashboardMessage.textContent = error.message;
      }
    } finally {
      trigger.disabled = false;
      trigger.classList.remove('is-loading');
      trigger.removeAttribute('aria-busy');
      trigger.title = originalTitle;
    }
  };

  const createInvoiceRow = (invoice) => {
    const row = document.createElement('tr');
    appendCell(row, String(invoice.id ?? '—'), 'invoice-id');
    appendCell(row, formatDate(invoice.issuedAt));
    appendCell(row, formatDate(invoice.dueAt));
    row.appendChild(createPdfCell(invoice));

    const clientCell = document.createElement('td');
    clientCell.className = 'client-cell';
    const clientName = document.createElement('strong');
    clientName.textContent = invoice.client || 'Não informado';
    clientCell.appendChild(clientName);
    if (invoice.clientDocument) {
      const documentLine = document.createElement('small');
      documentLine.textContent = formatCnpj(invoice.clientDocument);
      clientCell.appendChild(documentLine);
    }
    row.appendChild(clientCell);

    appendCell(row, formatCurrency(invoice.total), 'numeric');
    appendCell(row, formatCurrency(invoice.paid), 'numeric');
    appendCell(row, formatCurrency(invoice.balance), 'numeric');
    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge ${statusClass(invoice.status)}`;
    badge.textContent = invoice.statusLabel;
    statusCell.appendChild(badge);
    row.appendChild(statusCell);
    return row;
  };

  const sum = (invoices, key) => invoices.reduce((total, invoice) => {
    const value = invoice[key];
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);

  const updateSortHeaders = () => {
    elements.sortHeaders.forEach((button) => {
      const header = button.closest('th');
      const indicator = button.querySelector('.sort-indicator');
      const active = button.dataset.sortKey === state.sortKey;
      header.setAttribute(
        'aria-sort',
        active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
      );
      indicator.textContent = active
        ? (state.sortDirection === 'asc' ? '↑' : '↓')
        : '↕';
    });
  };

  const renderSortedRows = () => {
    const sorted = window.BillingSort.sortInvoices(
      state.invoices,
      state.sortKey,
      state.sortDirection
    );
    elements.invoiceRows.replaceChildren(...sorted.map(createInvoiceRow));
    updateSortHeaders();
  };

  const updatePaginationControls = () => {
    const page = Math.floor(state.skip / LIMIT) + 1;
    const previousDisabled = state.loading || state.skip === 0;
    const nextDisabled = state.loading || !state.hasMore;
    elements.pageIndicators.forEach((indicator) => {
      indicator.textContent = `Página ${page}`;
    });
    elements.previousPageButtons.forEach((button) => {
      button.disabled = previousDisabled;
    });
    elements.nextPageButtons.forEach((button) => {
      button.disabled = nextDisabled;
    });
  };

  const renderInvoices = (payload) => {
    const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
    state.invoices = invoices;
    const financialInvoices = invoices.filter((invoice) => {
      const statusLabel = String(invoice.statusLabel || '').toLocaleLowerCase('pt-BR');
      return invoice.status !== 2 && !statusLabel.startsWith('cancel');
    });
    renderSortedRows();
    elements.emptyState.hidden = invoices.length > 0;
    elements.invoiceCount.textContent = String(invoices.length);
    elements.invoiceCountLabel.textContent = 'Faturas na página';
    elements.totalAmountLabel.textContent = 'Valor total';
    elements.paidAmountLabel.textContent = 'Valor pago';
    elements.balanceAmountLabel.textContent = 'Saldo';
    elements.totalAmount.textContent = currency.format(sum(financialInvoices, 'total'));
    elements.paidAmount.textContent = currency.format(sum(financialInvoices, 'paid'));
    elements.balanceAmount.textContent = currency.format(sum(financialInvoices, 'balance'));

    state.hasMore = Boolean(payload.pagination?.hasMore);
    const start = invoices.length ? state.skip + 1 : 0;
    const end = state.skip + invoices.length;
    elements.resultRange.textContent = invoices.length
      ? `Exibindo ${start}–${end}`
      : 'Nenhum resultado nesta página';
    updatePaginationControls();
  };

  const chartColor = (index) => CHART_COLORS[index] ||
    `hsl(${Math.round((index * 137.508) % 360)} 58% 48%)`;

  const hideChartTooltip = () => {
    elements.chartTooltip.hidden = true;
    elements.debtorChart.classList.remove('has-highlight');
    elements.debtorChartSegments.querySelectorAll('.is-highlighted').forEach((segment) => {
      segment.classList.remove('is-highlighted');
    });
  };

  const positionChartTooltip = (clientX, clientY) => {
    const bounds = elements.donutWrap.getBoundingClientRect();
    const left = Math.max(8, Math.min(bounds.width - 8, clientX - bounds.left));
    const top = Math.max(54, Math.min(bounds.height - 8, clientY - bounds.top));
    elements.chartTooltip.style.left = `${left}px`;
    elements.chartTooltip.style.top = `${top}px`;
  };

  const showChartTooltip = (debtor, segment, clientX, clientY) => {
    elements.chartTooltipName.textContent = debtor.name || 'Não informado';
    elements.chartTooltipPercentage.textContent = `${percentage.format(debtor.percentage)}% do total`;
    elements.chartTooltipValue.textContent = currency.format(debtor.value);
    elements.chartTooltip.hidden = false;
    elements.debtorChart.classList.add('has-highlight');
    elements.debtorChartSegments.querySelectorAll('.is-highlighted').forEach((item) => {
      item.classList.remove('is-highlighted');
    });
    segment.classList.add('is-highlighted');
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      positionChartTooltip(clientX, clientY);
    } else {
      const bounds = elements.donutWrap.getBoundingClientRect();
      positionChartTooltip(bounds.left + bounds.width / 2, bounds.top + bounds.height * .2);
    }
  };

  const createChartSegment = (debtor, index, offset) => {
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const share = Math.max(0, Math.min(100, Number(debtor.percentage) || 0));
    segment.classList.add('donut-segment');
    segment.setAttribute('cx', '120');
    segment.setAttribute('cy', '120');
    segment.setAttribute('r', '82');
    segment.setAttribute('pathLength', '100');
    segment.setAttribute('stroke', chartColor(index));
    segment.setAttribute('stroke-dasharray', `${share} ${100 - share}`);
    segment.setAttribute('stroke-dashoffset', String(-offset));
    segment.setAttribute('transform', 'rotate(-90 120 120)');
    segment.setAttribute('tabindex', '0');
    segment.setAttribute('role', 'img');
    segment.setAttribute(
      'aria-label',
      `${debtor.name || 'Não informado'}: ${percentage.format(share)}% do total, ${currency.format(debtor.value)}`
    );

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${debtor.name || 'Não informado'} — ${percentage.format(share)}% — ${currency.format(debtor.value)}`;
    segment.appendChild(title);
    segment.addEventListener('pointerenter', (event) => {
      showChartTooltip(debtor, segment, event.clientX, event.clientY);
    });
    segment.addEventListener('pointermove', (event) => {
      positionChartTooltip(event.clientX, event.clientY);
    });
    segment.addEventListener('pointerleave', hideChartTooltip);
    segment.addEventListener('focus', () => showChartTooltip(debtor, segment));
    segment.addEventListener('blur', hideChartTooltip);
    return segment;
  };

  const createLegendItem = (debtor, index) => {
    const item = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = chartColor(index);
    swatch.setAttribute('aria-hidden', 'true');

    const company = document.createElement('div');
    company.className = 'legend-company';
    const name = document.createElement('strong');
    name.textContent = debtor.name || 'Não informado';
    company.appendChild(name);
    if (debtor.cnpj) {
      const cnpj = document.createElement('small');
      cnpj.textContent = formatCnpj(debtor.cnpj);
      company.appendChild(cnpj);
    }

    const value = document.createElement('div');
    value.className = 'legend-value';
    const amount = document.createElement('strong');
    amount.textContent = currency.format(debtor.value);
    const share = document.createElement('small');
    share.textContent = `${percentage.format(debtor.percentage)}%`;
    value.append(amount, share);
    item.append(swatch, company, value);
    return item;
  };

  const renderDebtorChart = (payload) => {
    const debtors = Array.isArray(payload.debtors)
      ? payload.debtors.filter((debtor) => Number(debtor.value) > 0)
      : [];
    hideChartTooltip();
    elements.debtorChartSegments.replaceChildren();
    elements.chartLegend.replaceChildren();

    let offset = 0;
    const segments = debtors.map((debtor, index) => {
      const segment = createChartSegment(debtor, index, offset);
      offset += Number(debtor.percentage) || 0;
      return segment;
    });
    elements.debtorChartSegments.replaceChildren(...segments);
    elements.chartLegend.replaceChildren(...debtors.map(createLegendItem));

    const totalPending = Number(payload.totalPending) || 0;
    const largestDebtor = payload.largestDebtor;
    elements.chartTotalPending.textContent = currency.format(totalPending);
    elements.invoiceCountLabel.textContent = 'Faturas pendentes';
    elements.invoiceCount.textContent = String(payload.invoiceCount || 0);
    elements.totalAmountLabel.textContent = 'Empresas devedoras';
    elements.totalAmount.textContent = String(payload.companyCount || debtors.length);
    elements.paidAmountLabel.textContent = 'Total pendente';
    elements.paidAmount.textContent = currency.format(totalPending);
    elements.balanceAmountLabel.textContent = 'Maior devedor';
    elements.balanceAmount.textContent = largestDebtor
      ? currency.format(largestDebtor.value)
      : currency.format(0);
    elements.chartResultDescription.textContent = debtors.length
      ? `${payload.invoiceCount || 0} fatura(s) pendente(s), agrupadas em ${debtors.length} empresa(s).`
      : 'Nenhum saldo pendente foi encontrado com os filtros informados.';
    elements.chartContent.hidden = debtors.length === 0;
    elements.chartEmptyState.hidden = debtors.length > 0;
  };

  const resetResults = () => {
    state.skip = 0;
    state.hasMore = false;
    state.invoices = [];
    state.sortKey = 'issuedAt';
    state.sortDirection = 'desc';
    state.hasSearched = false;
    elements.invoiceRows.replaceChildren();
    hideChartTooltip();
    elements.debtorChartSegments.replaceChildren();
    elements.chartLegend.replaceChildren();
    elements.chartContent.hidden = true;
    elements.chartEmptyState.hidden = false;
    elements.chartTotalPending.textContent = currency.format(0);
    elements.chartResultDescription.textContent = 'Faça uma consulta para gerar o gráfico.';
    updateSortHeaders();
    elements.emptyState.hidden = false;
    elements.emptyState.querySelector('strong').textContent = 'Faça sua primeira consulta';
    elements.emptyState.querySelector('p').textContent =
      'Informe os filtros desejados e clique em “Buscar faturas”.';
    elements.invoiceCount.textContent = '0';
    elements.invoiceCountLabel.textContent = state.view === 'debtors'
      ? 'Faturas pendentes'
      : 'Faturas na página';
    elements.totalAmountLabel.textContent = state.view === 'debtors'
      ? 'Empresas devedoras'
      : 'Valor total';
    elements.paidAmountLabel.textContent = state.view === 'debtors'
      ? 'Total pendente'
      : 'Valor pago';
    elements.balanceAmountLabel.textContent = state.view === 'debtors'
      ? 'Maior devedor'
      : 'Saldo';
    elements.totalAmount.textContent = currency.format(0);
    elements.paidAmount.textContent = currency.format(0);
    elements.balanceAmount.textContent = currency.format(0);
    elements.resultRange.textContent = 'Aguardando consulta';
    updatePaginationControls();
    elements.dashboardMessage.textContent = '';
  };

  const filterParams = () => {
    const params = new URLSearchParams();
    const data = new FormData(elements.filterForm);
    const exactInvoiceId = String(data.get('id') || '').trim();
    if (exactInvoiceId) state.skip = 0;
    for (const [key, rawValue] of data.entries()) {
      const value = String(rawValue).trim();
      if (value) params.set(key, key === 'cnpj' ? value.replace(/\D/g, '') : value);
    }
    params.set('limit', String(LIMIT));
    params.set('skip', String(state.skip));
    if (state.view === 'debtors') params.set('view', 'debtors');
    return params;
  };

  const setLoading = (loading) => {
    state.loading = loading;
    elements.tableLoading.hidden = !loading || state.view !== 'list';
    elements.chartLoading.hidden = !loading || state.view !== 'debtors';
    elements.filterForm.querySelectorAll('button, input, select').forEach((control) => {
      control.disabled = loading;
    });
    elements.viewButtons.forEach((button) => {
      button.disabled = loading;
    });
    updatePaginationControls();
  };

  const setView = (view) => {
    if (!['list', 'debtors'].includes(view) || state.view === view) return;
    state.view = view;
    state.skip = 0;
    elements.viewButtons.forEach((button) => {
      const active = button.dataset.viewMode === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    elements.tableView.hidden = view !== 'list';
    elements.chartView.hidden = view !== 'debtors';
    elements.dashboardMessage.textContent = '';
    if (state.hasSearched) {
      loadInvoices();
    } else {
      resetResults();
    }
    scheduleBackToTopUpdate();
  };

  const loadInvoices = async () => {
    if (state.loading) return;
    const params = filterParams();
    setLoading(true);
    elements.dashboardMessage.textContent = '';
    try {
      const payload = await requestJson(`/api/faturamento/faturas?${params}`);
      if (state.view === 'debtors') renderDebtorChart(payload);
      else renderInvoices(payload);
    } catch (error) {
      if (error.status === 401) {
        showPanel('login');
        elements.loginMessage.textContent = 'Sua sessão expirou. Entre novamente.';
      } else {
        elements.dashboardMessage.textContent = error.message;
      }
    } finally {
      setLoading(false);
    }
  };

  elements.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.loginMessage.textContent = '';
    const button = elements.loginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = new FormData(elements.loginForm);
      await requestJson('/api/faturamento/login', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password')
        })
      });
      elements.loginForm.reset();
      showPanel('dashboard');
      resetResults();
    } catch (error) {
      elements.loginMessage.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  elements.logoutButton.addEventListener('click', async () => {
    closeAllDocumentModals();
    elements.logoutButton.disabled = true;
    try {
      await requestJson('/api/faturamento/logout', { method: 'POST' });
    } catch {
      // A interface é encerrada mesmo se a resposta de logout falhar.
    } finally {
      state.skip = 0;
      elements.invoiceRows.replaceChildren();
      showPanel('login');
      elements.logoutButton.disabled = false;
    }
  });

  elements.filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.skip = 0;
    state.hasSearched = true;
    loadInvoices();
  });

  elements.clearFilters.addEventListener('click', () => {
    elements.filterForm.reset();
    resetResults();
  });

  elements.viewButtons.forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.viewMode));
  });

  elements.previousPageButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.skip = Math.max(0, state.skip - LIMIT);
      loadInvoices();
    });
  });

  elements.nextPageButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.hasMore) return;
      state.skip += LIMIT;
      loadInvoices();
    });
  });

  elements.sortHeaders.forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sortKey;
      if (state.sortKey === key) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDirection = window.BillingSort.defaultDirectionFor(key);
      }
      renderSortedRows();
    });
  });

  window.addEventListener('scroll', scheduleBackToTopUpdate, { passive: true });
  window.addEventListener('resize', scheduleBackToTopUpdate);

  elements.backToTopButton.addEventListener('click', () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({
      top: 0,
      behavior: reduceMotion ? 'auto' : 'smooth'
    });
  });

  elements.documentModalClose.addEventListener('click', closeDocumentModal);
  elements.documentModalBackdrop.addEventListener('click', closeDocumentModal);
  elements.bankSlipChoice.addEventListener('click', generateBankSlip);
  elements.nfseChoice.addEventListener('click', prepareNfse);
  elements.nfseIssueButton.addEventListener('click', issueNfse);
  elements.nfseConfirmClose.addEventListener('click', () => closeNfseConfirm(true));
  elements.nfseConfirmBackdrop.addEventListener('click', () => closeNfseConfirm(true));
  elements.nfseCancelButton.addEventListener('click', () => closeNfseConfirm(true));
  elements.invoicePdfChoice.addEventListener('click', closeDocumentModal);
  elements.dactePdfChoice.addEventListener('click', closeDocumentModal);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!elements.nfseConfirmModal.hidden) closeNfseConfirm(true);
    else if (!elements.documentModal.hidden) closeDocumentModal();
  });

  const start = async () => {
    showPanel('loading');
    try {
      const session = await requestJson('/api/faturamento/session');
      if (session.authenticated) {
        showPanel('dashboard');
        resetResults();
      } else {
        showPanel('login');
      }
    } catch (error) {
      showPanel('login');
      elements.loginMessage.textContent = error.message;
    }
  };

  start();
})();
