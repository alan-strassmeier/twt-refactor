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
    sortDirection: 'desc'
  };

  const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });

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
    const passedTableHeader = !elements.dashboardPanel.hidden &&
      elements.tableHeader.getBoundingClientRect().bottom <= 0;
    elements.backToTopButton.hidden = !passedTableHeader;
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

  const resetResults = () => {
    state.skip = 0;
    state.hasMore = false;
    state.invoices = [];
    state.sortKey = 'issuedAt';
    state.sortDirection = 'desc';
    elements.invoiceRows.replaceChildren();
    updateSortHeaders();
    elements.emptyState.hidden = false;
    elements.emptyState.querySelector('strong').textContent = 'Faça sua primeira consulta';
    elements.emptyState.querySelector('p').textContent =
      'Informe os filtros desejados e clique em “Buscar faturas”.';
    elements.invoiceCount.textContent = '0';
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
    return params;
  };

  const setLoading = (loading) => {
    state.loading = loading;
    elements.tableLoading.hidden = !loading;
    elements.filterForm.querySelectorAll('button, input, select').forEach((control) => {
      control.disabled = loading;
    });
    updatePaginationControls();
  };

  const loadInvoices = async () => {
    if (state.loading) return;
    const params = filterParams();
    setLoading(true);
    elements.dashboardMessage.textContent = '';
    try {
      const payload = await requestJson(`/api/faturamento/faturas?${params}`);
      renderInvoices(payload);
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
    loadInvoices();
  });

  elements.clearFilters.addEventListener('click', () => {
    elements.filterForm.reset();
    resetResults();
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
