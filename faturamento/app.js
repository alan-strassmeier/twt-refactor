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
    previousPage: document.getElementById('previousPage'),
    nextPage: document.getElementById('nextPage'),
    pageIndicator: document.getElementById('pageIndicator'),
    resultRange: document.getElementById('resultRange'),
    invoiceCount: document.getElementById('invoiceCount'),
    totalAmount: document.getElementById('totalAmount'),
    paidAmount: document.getElementById('paidAmount'),
    balanceAmount: document.getElementById('balanceAmount')
  };

  const state = {
    skip: 0,
    hasMore: false,
    loading: false
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

  const showPanel = (panel) => {
    elements.loadingPanel.hidden = panel !== 'loading';
    elements.loginPanel.hidden = panel !== 'login';
    elements.dashboardPanel.hidden = panel !== 'dashboard';
    elements.logoutButton.hidden = panel !== 'dashboard';
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

  const createInvoiceRow = (invoice) => {
    const row = document.createElement('tr');
    appendCell(row, String(invoice.id ?? '—'), 'invoice-id');
    appendCell(row, formatDate(invoice.issuedAt));
    appendCell(row, formatDate(invoice.dueAt));
    appendCell(row, formatDate(invoice.paidAt));

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

  const renderInvoices = (payload) => {
    const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
    const financialInvoices = invoices.filter((invoice) => {
      const statusLabel = String(invoice.statusLabel || '').toLocaleLowerCase('pt-BR');
      return invoice.status !== 2 && !statusLabel.startsWith('cancel');
    });
    elements.invoiceRows.replaceChildren(...invoices.map(createInvoiceRow));
    elements.emptyState.hidden = invoices.length > 0;
    elements.invoiceCount.textContent = String(invoices.length);
    elements.totalAmount.textContent = currency.format(sum(financialInvoices, 'total'));
    elements.paidAmount.textContent = currency.format(sum(financialInvoices, 'paid'));
    elements.balanceAmount.textContent = currency.format(sum(financialInvoices, 'balance'));

    state.hasMore = Boolean(payload.pagination?.hasMore);
    const page = Math.floor(state.skip / LIMIT) + 1;
    const start = invoices.length ? state.skip + 1 : 0;
    const end = state.skip + invoices.length;
    elements.pageIndicator.textContent = `Página ${page}`;
    elements.resultRange.textContent = invoices.length
      ? `Exibindo ${start}–${end}`
      : 'Nenhum resultado nesta página';
    elements.previousPage.disabled = state.skip === 0;
    elements.nextPage.disabled = !state.hasMore;
  };

  const resetResults = () => {
    state.skip = 0;
    state.hasMore = false;
    elements.invoiceRows.replaceChildren();
    elements.emptyState.hidden = false;
    elements.emptyState.querySelector('strong').textContent = 'Faça sua primeira consulta';
    elements.emptyState.querySelector('p').textContent =
      'Informe os filtros desejados e clique em “Buscar faturas”.';
    elements.invoiceCount.textContent = '0';
    elements.totalAmount.textContent = currency.format(0);
    elements.paidAmount.textContent = currency.format(0);
    elements.balanceAmount.textContent = currency.format(0);
    elements.pageIndicator.textContent = 'Página 1';
    elements.resultRange.textContent = 'Aguardando consulta';
    elements.previousPage.disabled = true;
    elements.nextPage.disabled = true;
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
    if (!loading) {
      elements.previousPage.disabled = state.skip === 0;
      elements.nextPage.disabled = !state.hasMore;
    } else {
      elements.previousPage.disabled = true;
      elements.nextPage.disabled = true;
    }
  };

  const loadInvoices = async () => {
    if (state.loading) return;
    setLoading(true);
    elements.dashboardMessage.textContent = '';
    try {
      const payload = await requestJson(`/api/faturamento/faturas?${filterParams()}`);
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

  elements.previousPage.addEventListener('click', () => {
    state.skip = Math.max(0, state.skip - LIMIT);
    loadInvoices();
  });

  elements.nextPage.addEventListener('click', () => {
    if (!state.hasMore) return;
    state.skip += LIMIT;
    loadInvoices();
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
