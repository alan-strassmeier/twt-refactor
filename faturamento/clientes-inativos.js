(() => {
  'use strict';

  const elements = {
    tab: document.querySelector('[data-billing-area="inactive"]'),
    workspace: document.getElementById('inactiveWorkspace'),
    refresh: document.getElementById('refreshInactiveClients'),
    message: document.getElementById('inactiveClientsMessage'),
    count: document.getElementById('inactiveClientsCount'),
    companies: document.getElementById('inactiveCompaniesCount'),
    updatedAt: document.getElementById('inactiveUpdatedAt'),
    rows: document.getElementById('inactiveClientsRows'),
    daysHeader: document.getElementById('inactiveDaysHeader'),
    daysSort: document.getElementById('sortInactiveDays'),
    empty: document.getElementById('inactiveClientsEmpty'),
    logout: document.getElementById('logoutButton')
  };
  if (!elements.workspace || !elements.tab) return;

  const state = { loaded: false, loading: false, snapshot: null, version: 0, sort: 'desc' };
  const endpoint = '/api/faturamento/cobranca?route=inactive-clients';

  const request = async (body) => {
    const response = await fetch(endpoint, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const result = (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json()
      : { message: 'Resposta inválida do servidor.' };
    if (!response.ok) {
      const error = new Error(result.message || 'Não foi possível atualizar os clientes inativos.');
      error.status = response.status;
      throw error;
    }
    return result;
  };

  const setMessage = (message, kind = '') => {
    elements.message.textContent = message;
    elements.message.dataset.kind = kind;
  };

  const setLoading = (loading) => {
    state.loading = loading;
    elements.refresh.disabled = loading;
    elements.refresh.textContent = loading ? 'Atualizando…' : 'Atualizar';
  };

  const saoPauloToday = () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };

  const daysSince = (date) => Math.max(0, Math.floor(
    (Date.parse(`${saoPauloToday()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000
  ));

  const formatDate = (date) => {
    const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
  };

  const formatDateTime = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short'
    }).format(date);
  };

  const formatCnpj = (value) => String(value || '').replace(/\D/g, '')
    .replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

  const missingTradeName = (client) => {
    const name = String(client.name || '').trim();
    return !name || name.replace(/\D/g, '') === client.cnpj ||
      name === 'Nome fantasia não localizado';
  };

  const cell = (row, value) => {
    const item = document.createElement('td');
    item.textContent = value;
    row.appendChild(item);
  };

  const renderSort = () => {
    if (!elements.daysHeader || !elements.daysSort) return;
    elements.daysHeader.setAttribute('aria-sort', state.sort === 'asc' ? 'ascending' : 'descending');
    elements.daysSort.setAttribute('aria-label',
      `Ordenar dias sem fatura em ordem ${state.sort === 'asc' ? 'decrescente' : 'crescente'}`);
    elements.daysSort.querySelector('span').textContent = state.sort === 'asc' ? '▲' : '▼';
  };

  const render = (snapshot) => {
    state.snapshot = snapshot;
    elements.rows.replaceChildren();
    renderSort();
    if (!snapshot) {
      elements.count.textContent = '—';
      elements.companies.textContent = '—';
      elements.updatedAt.textContent = 'Nunca';
      elements.empty.hidden = false;
      elements.empty.querySelector('strong').textContent = 'Lista ainda não atualizada';
      elements.empty.querySelector('p').textContent =
        'Clique em Atualizar para buscar o histórico de faturas na Brudam.';
      return;
    }
    const clients = Array.isArray(snapshot.clients) ? snapshot.clients : [];
    elements.count.textContent = String(clients.length);
    elements.companies.textContent = String(snapshot.totalCompanies || 0);
    elements.updatedAt.textContent = formatDateTime(snapshot.updatedAt);
    elements.empty.hidden = clients.length > 0;
    if (!clients.length) {
      elements.empty.querySelector('strong').textContent = 'Nenhum cliente inativo';
      elements.empty.querySelector('p').textContent =
        'Todas as empresas encontradas tiveram faturas emitidas nos últimos 31 dias.';
    }
    const fragment = document.createDocumentFragment();
    const sorted = [...clients].sort((left, right) => {
      const daysLeft = daysSince(left.lastIssuedAt);
      const daysRight = daysSince(right.lastIssuedAt);
      return (state.sort === 'asc' ? daysLeft - daysRight : daysRight - daysLeft) ||
        String(left.name || '').localeCompare(String(right.name || ''), 'pt-BR') ||
        String(left.cnpj || '').localeCompare(String(right.cnpj || ''));
    });
    sorted.forEach((client) => {
      const row = document.createElement('tr');
      cell(row, missingTradeName(client) ? 'Nome fantasia não localizado' : client.name);
      cell(row, formatCnpj(client.cnpj));
      cell(row, client.lastInvoiceId || '—');
      cell(row, formatDate(client.lastIssuedAt));
      const days = daysSince(client.lastIssuedAt);
      cell(row, Number.isFinite(days) ? String(days) : '—');
      fragment.appendChild(row);
    });
    elements.rows.appendChild(fragment);
  };

  const progressMessage = (refresh) =>
    (refresh.phase === 'names'
      ? `Conferidos ${refresh.namesLookedUp} de ${refresh.namesTotal} nomes fantasia na Brudam. `
      : `Consultadas ${refresh.invoicesRead} fatura(s) em ${refresh.pagesRead} página(s); ` +
        `${refresh.companiesFound} empresa(s) identificada(s). `) +
    'A lista anterior permanece visível até o fim.';

  const loadCached = async () => {
    if (state.loaded || state.loading) return;
    const version = ++state.version;
    setLoading(true);
    setMessage('Carregando a última lista salva no Redis…');
    try {
      const result = await request();
      if (version !== state.version) return;
      render(result.snapshot);
      state.loaded = true;
      if (result.refresh) {
        setMessage(`Há uma atualização incompleta. Clique em Atualizar para continuar. ${progressMessage(result.refresh)}`, 'warning');
      } else if (result.snapshot?.clients?.some(missingTradeName)) {
        setMessage('Há empresas sem nome fantasia nesta lista. Clique em Atualizar para consultar os cadastros na Brudam.', 'warning');
      } else if (result.snapshot?.ignoredInvoices) {
        setMessage(`${result.snapshot.ignoredInvoices} fatura(s) sem CNPJ ou data de emissão não puderam ser classificadas.`, 'warning');
      } else {
        setMessage('');
      }
    } catch (error) {
      if (version === state.version) setMessage(error.message, 'error');
    } finally {
      if (version === state.version) setLoading(false);
    }
  };

  elements.tab.addEventListener('click', loadCached);
  elements.daysSort?.addEventListener('click', () => {
    state.sort = state.sort === 'desc' ? 'asc' : 'desc';
    render(state.snapshot);
  });
  elements.refresh.addEventListener('click', async () => {
    if (state.loading) return;
    const version = ++state.version;
    setLoading(true);
    setMessage('Iniciando a atualização; a lista anterior será preservada até a conclusão…');
    try {
      const started = await request({ action: 'start' });
      if (version !== state.version) return;
      const runId = started.refresh?.runId;
      if (!runId) throw new Error('A atualização não retornou um identificador válido.');
      let complete = false;
      let busyRetries = 0;
      while (!complete && version === state.version) {
        try {
          const result = await request({ action: 'continue', runId });
          if (version !== state.version) return;
          busyRetries = 0;
          complete = result.complete === true;
          if (complete) {
            render(result.snapshot);
            state.loaded = true;
            const ignored = Number(result.snapshot?.ignoredInvoices || 0);
            const missing = Number(result.snapshot?.missingTradeNames || 0);
            setMessage(
              `Atualização concluída: ${result.snapshot.clients.length} cliente(s) inativo(s) ` +
              `entre ${result.snapshot.totalCompanies} empresa(s) com faturas.` +
              (ignored ? ` ${ignored} fatura(s) sem CNPJ ou emissão não puderam ser classificadas.` : '') +
              (missing ? ` ${missing} nome(s) fantasia não foram localizados na Brudam.` : ''),
              ignored || missing ? 'warning' : 'success'
            );
          } else {
            setMessage(progressMessage(result.refresh));
            await new Promise((resolve) => setTimeout(resolve, 450));
          }
        } catch (error) {
          if (error.status === 409 && error.message.startsWith('Atualização expirada')) {
            const current = await request();
            if (version !== state.version) return;
            if (current.snapshot &&
                Date.parse(current.snapshot.updatedAt) >= Date.parse(started.refresh.startedAt)) {
              render(current.snapshot);
              state.loaded = true;
              setMessage('A atualização foi concluída em outra sessão. A nova lista foi carregada.', 'success');
              complete = true;
              continue;
            }
          }
          if (error.status !== 409 || !error.message.startsWith('Outro lote') || ++busyRetries > 20) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      if (version === state.version) {
        setMessage(`${error.message} A lista anterior foi preservada; clique em Atualizar para tentar continuar.`, 'error');
      }
    } finally {
      if (version === state.version) setLoading(false);
    }
  });

  elements.logout?.addEventListener('click', () => {
    state.version += 1;
    state.loaded = false;
    setLoading(false);
    render(null);
    setMessage('');
  });
})();
