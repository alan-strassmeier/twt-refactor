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
    dateFilterInputs: [...document.querySelectorAll('[data-date-filter]')],
    datePickerInputs: [...document.querySelectorAll('[data-date-picker]')],
    datePickerTriggers: [...document.querySelectorAll('[data-date-trigger]')],
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
    agingSummary: document.getElementById('agingSummary'),
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

  const saoPauloToday = () => {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };

  const isoDayNumber = (value) => {
    const normalized = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
    const timestamp = Date.parse(`${normalized}T00:00:00Z`);
    if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== normalized) {
      return null;
    }
    return Math.floor(timestamp / 86400000);
  };

  const invoiceDueTiming = (invoice, today = saoPauloToday()) => {
    const statusLabel = String(invoice.statusLabel || '').toLocaleLowerCase('pt-BR');
    if (invoice.status === 2 || statusLabel.startsWith('cancel')) {
      return { label: 'Cancelada', className: 'is-closed' };
    }
    if (
      invoice.status === 1 ||
      ['liquid', 'pago', 'quitad'].some((term) => statusLabel.includes(term))
    ) {
      return { label: 'Liquidada', className: 'is-closed' };
    }
    const dueDay = isoDayNumber(invoice.dueAt);
    const todayDay = isoDayNumber(today);
    if (dueDay === null || todayDay === null) {
      return { label: 'Não informado', className: 'is-unknown' };
    }
    const daysUntilDue = dueDay - todayDay;
    if (daysUntilDue < 0) {
      const overdueDays = Math.abs(daysUntilDue);
      return {
        label: `${overdueDays} ${overdueDays === 1 ? 'dia' : 'dias'} em atraso`,
        className: 'is-overdue'
      };
    }
    if (daysUntilDue === 0) return { label: 'Vence hoje', className: 'is-today' };
    if (daysUntilDue === 1) return { label: 'Vence amanhã', className: 'is-soon' };
    return {
      label: `${daysUntilDue} dias para vencer`,
      className: daysUntilDue <= 7 ? 'is-soon' : 'is-future'
    };
  };

  const maskBrazilianDate = (value) => {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
    return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)]
      .filter(Boolean)
      .join('/');
  };

  const dateFilterToIso = (value) => {
    const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return '';
    const [, day, month, year] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day)
    ) return '';
    return `${year}-${month}-${day}`;
  };

  const isoDateToBrazilian = (value) => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
  };

  const validateDateFilter = (input) => {
    const isoDate = dateFilterToIso(input.value);
    const valid = !input.value || Boolean(isoDate);
    input.setCustomValidity(valid ? '' : 'Informe uma data válida no formato dd/mm/aaaa.');
    const picker = input.closest('.date-filter-control')?.querySelector('[data-date-picker]');
    if (picker) picker.value = isoDate;
    return valid;
  };

  const openDatePicker = (trigger) => {
    const control = trigger.closest('.date-filter-control');
    const input = control?.querySelector('[data-date-filter]');
    const picker = control?.querySelector('[data-date-picker]');
    if (!picker) return;
    const currentDate = dateFilterToIso(input?.value);
    if (currentDate) picker.value = currentDate;
    if (typeof picker.showPicker === 'function') {
      try {
        picker.showPicker();
        return;
      } catch {
        // Navegadores antigos podem expor showPicker sem permitir seu uso.
      }
    }
    picker.focus({ preventScroll: true });
    picker.click();
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

  const createDueTimingCell = (invoice, today) => {
    const cell = document.createElement('td');
    const timing = invoiceDueTiming(invoice, today);
    const badge = document.createElement('span');
    badge.className = `due-timing ${timing.className}`;
    badge.textContent = timing.label;
    cell.appendChild(badge);
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

  const createInvoiceRow = (invoice, today) => {
    const row = document.createElement('tr');
    appendCell(row, String(invoice.id ?? '—'), 'invoice-id');
    appendCell(row, formatDate(invoice.issuedAt));
    appendCell(row, formatDate(invoice.dueAt));
    row.appendChild(createDueTimingCell(invoice, today));
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
    const today = saoPauloToday();
    elements.invoiceRows.replaceChildren(...sorted.map((invoice) => createInvoiceRow(invoice, today)));
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

  let selectedChartIndex = null;

  const clearChartHighlight = () => {
    elements.debtorChart.classList.remove('has-highlight');
    elements.chartLegend.classList.remove('has-highlight');
    elements.debtorChartSegments.querySelectorAll('.is-highlighted').forEach((segment) => {
      segment.classList.remove('is-highlighted');
    });
    elements.chartLegend.querySelectorAll('.is-highlighted').forEach((item) => {
      item.classList.remove('is-highlighted');
    });
  };

  const highlightChartEntry = (index, scrollLegend = false) => {
    clearChartHighlight();
    const selector = `[data-chart-index="${index}"]`;
    const segment = elements.debtorChartSegments.querySelector(selector);
    const legendItem = elements.chartLegend.querySelector(selector);
    if (!segment || !legendItem) return;
    elements.debtorChart.classList.add('has-highlight');
    elements.chartLegend.classList.add('has-highlight');
    segment.classList.add('is-highlighted');
    legendItem.classList.add('is-highlighted');
    if (scrollLegend && typeof legendItem.scrollIntoView === 'function') {
      legendItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const setSelectedChartIndex = (index) => {
    selectedChartIndex = index;
    elements.debtorChartSegments.querySelectorAll('.donut-segment').forEach((segment) => {
      segment.setAttribute(
        'aria-pressed',
        String(index !== null && segment.dataset.chartIndex === String(index))
      );
    });
  };

  const hideChartTooltip = () => {
    elements.chartTooltip.hidden = true;
    if (selectedChartIndex === null) clearChartHighlight();
    else highlightChartEntry(selectedChartIndex);
  };

  const positionChartTooltip = (clientX, clientY) => {
    const bounds = elements.donutWrap.getBoundingClientRect();
    const left = Math.max(8, Math.min(bounds.width - 8, clientX - bounds.left));
    const top = Math.max(54, Math.min(bounds.height - 8, clientY - bounds.top));
    elements.chartTooltip.style.left = `${left}px`;
    elements.chartTooltip.style.top = `${top}px`;
  };

  const showChartTooltip = (debtor, index, clientX, clientY) => {
    elements.chartTooltipName.textContent = debtor.name || 'Não informado';
    elements.chartTooltipPercentage.textContent = `${percentage.format(debtor.percentage)}% do total`;
    elements.chartTooltipValue.textContent = currency.format(debtor.value);
    elements.chartTooltip.hidden = false;
    highlightChartEntry(index, true);
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
    segment.setAttribute('data-chart-index', String(index));
    segment.setAttribute('tabindex', '0');
    segment.setAttribute('role', 'button');
    segment.setAttribute('aria-pressed', 'false');
    segment.setAttribute(
      'aria-label',
      `${debtor.name || 'Não informado'}: ${percentage.format(share)}% do total, ${currency.format(debtor.value)}`
    );

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${debtor.name || 'Não informado'} — ${percentage.format(share)}% — ${currency.format(debtor.value)}`;
    segment.appendChild(title);
    segment.addEventListener('pointerenter', (event) => {
      showChartTooltip(debtor, index, event.clientX, event.clientY);
    });
    segment.addEventListener('pointermove', (event) => {
      positionChartTooltip(event.clientX, event.clientY);
    });
    segment.addEventListener('pointerleave', hideChartTooltip);
    segment.addEventListener('focus', () => showChartTooltip(debtor, index));
    segment.addEventListener('blur', hideChartTooltip);
    segment.addEventListener('click', (event) => {
      const nextIndex = selectedChartIndex === index ? null : index;
      setSelectedChartIndex(nextIndex);
      if (nextIndex === null) {
        elements.chartTooltip.hidden = true;
        clearChartHighlight();
        return;
      }
      showChartTooltip(
        debtor,
        index,
        event.detail ? event.clientX : undefined,
        event.detail ? event.clientY : undefined
      );
    });
    segment.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      segment.click();
    });
    return segment;
  };

  const createLegendItem = (debtor, index) => {
    const item = document.createElement('li');
    item.dataset.chartIndex = String(index);
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
      const action = document.createElement('span');
      action.className = 'legend-action';
      action.textContent = 'Ver faturas →';
      company.appendChild(action);
    }

    const value = document.createElement('div');
    value.className = 'legend-value';
    const amount = document.createElement('strong');
    amount.textContent = currency.format(debtor.value);
    const share = document.createElement('small');
    share.textContent = `${percentage.format(debtor.percentage)}%`;
    value.append(amount, share);
    item.append(swatch, company, value);
    item.addEventListener('pointerenter', () => highlightChartEntry(index));
    item.addEventListener('pointerleave', hideChartTooltip);
    item.addEventListener('focus', () => highlightChartEntry(index));
    item.addEventListener('blur', hideChartTooltip);
    if (debtor.cnpj) {
      const showInvoices = () => {
        const cnpjInput = elements.filterForm.elements.namedItem('cnpj');
        const statusInput = elements.filterForm.elements.namedItem('status');
        cnpjInput.value = formatCnpj(debtor.cnpj);
        if (!statusInput.value) statusInput.value = '0';
        state.skip = 0;
        state.hasSearched = true;
        setView('list');
      };
      item.classList.add('is-actionable');
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', `Ver faturas de ${debtor.name || formatCnpj(debtor.cnpj)}`);
      item.addEventListener('click', showInvoices);
      item.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        showInvoices();
      });
    }
    return item;
  };

  const createAgingCard = (bucket) => {
    const card = document.createElement('article');
    const tone = bucket.key === 'current'
      ? 'is-current'
      : (bucket.key === 'unknown' ? 'is-unknown' : 'is-overdue');
    card.className = `aging-card ${tone}`;
    const label = document.createElement('span');
    label.textContent = bucket.label;
    const value = document.createElement('strong');
    value.textContent = currency.format(Number(bucket.value) || 0);
    const count = document.createElement('small');
    const invoiceCount = Number(bucket.invoiceCount) || 0;
    count.textContent = `${invoiceCount} ${invoiceCount === 1 ? 'fatura' : 'faturas'}`;
    card.append(label, value, count);
    return card;
  };

  const renderAgingSummary = (buckets) => {
    const agingBuckets = Array.isArray(buckets) ? buckets : [];
    elements.agingSummary.replaceChildren(...agingBuckets.map(createAgingCard));
  };

  const renderDebtorChart = (payload) => {
    const debtors = Array.isArray(payload.debtors)
      ? payload.debtors.filter((debtor) => Number(debtor.value) > 0)
      : [];
    setSelectedChartIndex(null);
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
    renderAgingSummary(payload.agingBuckets);

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
    setSelectedChartIndex(null);
    hideChartTooltip();
    elements.debtorChartSegments.replaceChildren();
    elements.chartLegend.replaceChildren();
    elements.agingSummary.replaceChildren();
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
      if (!value) continue;
      const dateInput = elements.dateFilterInputs.find((input) => input.name === key);
      params.set(
        key,
        key === 'cnpj'
          ? value.replace(/\D/g, '')
          : (dateInput ? dateFilterToIso(value) : value)
      );
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
    if (!elements.dateFilterInputs.every(validateDateFilter)) {
      elements.filterForm.reportValidity();
      return;
    }
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
    if (!elements.dateFilterInputs.every(validateDateFilter)) {
      elements.filterForm.reportValidity();
      return;
    }
    state.skip = 0;
    state.hasSearched = true;
    loadInvoices();
  });

  elements.clearFilters.addEventListener('click', () => {
    elements.filterForm.reset();
    elements.dateFilterInputs.forEach((input) => input.setCustomValidity(''));
    resetResults();
  });

  elements.dateFilterInputs.forEach((input) => {
    input.addEventListener('input', () => {
      input.value = maskBrazilianDate(input.value);
      validateDateFilter(input);
    });
    input.addEventListener('blur', () => validateDateFilter(input));
  });

  elements.datePickerInputs.forEach((picker) => {
    picker.addEventListener('change', () => {
      const input = picker.closest('.date-filter-control')?.querySelector('[data-date-filter]');
      if (!input) return;
      input.value = isoDateToBrazilian(picker.value);
      validateDateFilter(input);
    });
  });

  elements.datePickerTriggers.forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDatePicker(trigger);
    });
  });

  elements.viewButtons.forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.viewMode));
  });

  document.addEventListener('click', (event) => {
    if (selectedChartIndex === null || elements.debtorChart.contains(event.target)) return;
    setSelectedChartIndex(null);
    hideChartTooltip();
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
