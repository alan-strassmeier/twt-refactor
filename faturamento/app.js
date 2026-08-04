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
    backToTopButton: document.getElementById('backToTopButton')
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

    const link = document.createElement('a');
    link.className = 'pdf-link';
    link.href = `/api/faturamento/fatura-pdf?id=${encodeURIComponent(invoiceId)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Visualizar PDF da fatura ${invoiceId} em nova guia`);
    link.title = `Visualizar fatura ${invoiceId}`;
    const icon = document.createElement('span');
    icon.className = 'pdf-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'PDF';
    link.appendChild(icon);
    cell.appendChild(link);
    return cell;
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
