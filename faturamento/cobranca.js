(() => {
  'use strict';

  const elements = {
    areaButtons: [...document.querySelectorAll('[data-billing-area]')],
    invoiceWorkspace: document.getElementById('invoiceWorkspace'),
    collectionWorkspace: document.getElementById('collectionWorkspace'),
    message: document.getElementById('collectionMessage'),
    runButton: document.getElementById('runCollectionButton'),
    companyCount: document.getElementById('collectionCompanyCount'),
    contactCount: document.getElementById('collectionContactCount'),
    pendingCount: document.getElementById('collectionPendingCount'),
    categoryForm: document.getElementById('categoryForm'),
    categoryList: document.getElementById('categoryList'),
    categoryEmpty: document.getElementById('categoryEmpty'),
    pendingRows: document.getElementById('pendingRows'),
    pendingEmpty: document.getElementById('pendingEmpty'),
    pendingRunStatus: document.getElementById('pendingRunStatus'),
    refreshPendingButton: document.getElementById('refreshPendingButton'),
    logsForm: document.getElementById('collectionLogsForm'),
    clearLogsButton: document.getElementById('clearCollectionLogs'),
    logRows: document.getElementById('collectionLogRows'),
    logsEmpty: document.getElementById('collectionLogsEmpty'),
    previousLogPage: document.getElementById('previousLogPage'),
    nextLogPage: document.getElementById('nextLogPage'),
    logPageIndicator: document.getElementById('logPageIndicator'),
    categoryDeleteModal: document.getElementById('categoryDeleteModal'),
    categoryDeleteBackdrop: document.getElementById('categoryDeleteBackdrop'),
    categoryDeleteDescription: document.getElementById('categoryDeleteDescription'),
    cancelCategoryDelete: document.getElementById('cancelCategoryDelete'),
    confirmCategoryDelete: document.getElementById('confirmCategoryDelete'),
    emailLogModal: document.getElementById('emailLogModal'),
    emailLogBackdrop: document.getElementById('emailLogBackdrop'),
    emailLogClose: document.getElementById('emailLogClose'),
    emailLogTitle: document.getElementById('emailLogTitle'),
    emailLogContent: document.getElementById('emailLogContent'),
    emailLogFrom: document.getElementById('emailLogFrom'),
    emailLogTo: document.getElementById('emailLogTo'),
    emailLogSubject: document.getElementById('emailLogSubject'),
    emailLogPriority: document.getElementById('emailLogPriority'),
    emailLogBody: document.getElementById('emailLogBody'),
    emailLogAttachments: document.getElementById('emailLogAttachments'),
    emailLogUnavailable: document.getElementById('emailLogUnavailable'),
    backToTopButton: document.getElementById('backToTopButton')
  };

  if (!elements.collectionWorkspace) return;

  const state = {
    loaded: false,
    loading: false,
    categories: [],
    logFilters: {},
    logPage: 1,
    logTotalPages: 1,
    categoryToDelete: null,
    categoryDeleteTrigger: null,
    emailLogTrigger: null
  };
  const endpoint = (route, query = {}) => {
    const params = new URLSearchParams({ route, ...query });
    return `/api/faturamento/cobranca?${params}`;
  };

  const requestJson = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const payload = (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json()
      : { message: 'Resposta inválida do servidor.' };
    if (!response.ok) {
      const error = new Error(payload.message || 'Não foi possível concluir a solicitação.');
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const formatCnpj = (value) => {
    const number = String(value || '').replace(/\D/g, '');
    return number.length === 14
      ? number.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
      : value || '—';
  };

  const formatDate = (value) => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : value || '—';
  };

  const formatDateTime = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(date);
  };

  const appendCell = (row, value) => {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
  };

  const setMessage = (message, kind = '') => {
    elements.message.textContent = message;
    elements.message.dataset.kind = kind;
  };

  const setLoading = (loading) => {
    state.loading = loading;
    elements.collectionWorkspace.querySelectorAll('button, input').forEach((control) => {
      control.disabled = loading;
    });
    elements.previousLogPage.disabled = loading || state.logPage <= 1;
    elements.nextLogPage.disabled = loading || state.logPage >= state.logTotalPages;
  };

  const deleteContact = async (cnpj, id) => {
    if (!window.confirm('Excluir este contato de cobrança também da Brudam?')) return;
    setLoading(true);
    try {
      const result = await requestJson(endpoint('contacts', { cnpj, id }), { method: 'DELETE' });
      setMessage(result.message || 'Contato excluído.', 'success');
      await loadCategories();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const setContactEnabled = async (category, contact, enabled) => {
    setLoading(true);
    try {
      await requestJson(endpoint('contacts'), {
        method: 'PATCH',
        body: JSON.stringify({ cnpj: category.cnpj, id: contact.id, enabled })
      });
      setMessage(enabled ? 'Contato habilitado para envio.' : 'Contato desabilitado para envio.', 'success');
      await loadCategories();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const syncContacts = async (category) => {
    setLoading(true);
    try {
      const result = await requestJson(endpoint('contacts-sync'), {
        method: 'POST',
        body: JSON.stringify({ cnpj: category.cnpj })
      });
      setMessage(result.message, 'success');
      await loadCategories();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const createContactItem = (category, contact) => {
    const item = document.createElement('li');
    item.className = 'contact-item';
    const enabled = contact.enabled !== false;
    item.classList.toggle('is-disabled', !enabled);
    const identity = document.createElement('div');
    identity.className = 'contact-identity';
    const name = document.createElement('strong');
    name.textContent = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const email = document.createElement('a');
    email.href = `mailto:${contact.email}`;
    email.textContent = contact.email;
    identity.append(name, email);
    const actions = document.createElement('div');
    actions.className = 'contact-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `contact-send-toggle ${enabled ? 'is-enabled' : 'is-disabled'}`;
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.setAttribute('aria-label', `${enabled ? 'Desabilitar' : 'Habilitar'} envio para ${name.textContent}`);
    toggle.textContent = enabled ? 'Envio ✔️' : 'Envio ❌';
    toggle.addEventListener('click', () => setContactEnabled(category, contact, !enabled));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-action danger-action';
    remove.setAttribute('aria-label', `Excluir ${name.textContent}`);
    remove.title = 'Excluir contato';
    remove.textContent = 'Excluir';
    remove.addEventListener('click', () => deleteContact(category.cnpj, contact.id));
    actions.append(toggle, remove);
    item.append(identity, actions);
    return item;
  };

  const saveContact = async (category, form) => {
    const data = new FormData(form);
    setLoading(true);
    try {
      await requestJson(endpoint('contacts'), {
        method: 'POST',
        body: JSON.stringify({
          cnpj: category.cnpj,
          firstName: data.get('firstName'),
          lastName: data.get('lastName'),
          email: data.get('email')
        })
      });
      form.reset();
      setMessage('Contato salvo.', 'success');
      await loadCategories();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const closeCategoryDeleteModal = () => {
    if (elements.categoryDeleteModal.hidden) return;
    elements.categoryDeleteModal.hidden = true;
    document.body.classList.remove('modal-open');
    state.categoryDeleteTrigger?.focus();
    state.categoryDeleteTrigger = null;
    state.categoryToDelete = null;
  };

  const requestCategoryDeletion = (category, trigger) => {
    state.categoryToDelete = category;
    state.categoryDeleteTrigger = trigger;
    elements.categoryDeleteDescription.textContent =
      `Excluir ${category.name} e todos os seus contatos de cobrança?`;
    elements.categoryDeleteModal.hidden = false;
    document.body.classList.add('modal-open');
    elements.cancelCategoryDelete.focus();
  };

  const emailParty = (name, email) => [name, email && `<${email}>`].filter(Boolean).join(' ') || '—';

  const closeEmailLogModal = () => {
    if (elements.emailLogModal.hidden) return;
    elements.emailLogModal.hidden = true;
    document.body.classList.remove('modal-open');
    state.emailLogTrigger?.focus();
    state.emailLogTrigger = null;
  };

  const openEmailLogModal = (record, trigger) => {
    const preview = record.emailPreview;
    const available = Boolean(preview && preview.subject && preview.text);
    state.emailLogTrigger = trigger;
    elements.emailLogTitle.textContent = `E-mail da fatura ${record.invoiceId || '—'}`;
    elements.emailLogContent.hidden = !available;
    elements.emailLogUnavailable.hidden = available;
    if (available) {
      elements.emailLogFrom.textContent = emailParty(preview.fromName, preview.fromEmail);
      elements.emailLogTo.textContent = emailParty(preview.toName, preview.toEmail || record.email);
      elements.emailLogSubject.textContent = preview.subject;
      elements.emailLogPriority.textContent = preview.priority === 'high' ? 'Alta' : 'Normal';
      elements.emailLogBody.textContent = preview.text;
      const attachments = Array.isArray(preview.attachments) ? preview.attachments : [];
      elements.emailLogAttachments.replaceChildren(...attachments.map((filename) => {
        const item = document.createElement('li');
        item.textContent = filename;
        return item;
      }));
    }
    elements.emailLogModal.hidden = false;
    document.body.classList.add('modal-open');
    elements.emailLogClose.focus();
  };

  const deleteCategory = async (category) => {
    setLoading(true);
    try {
      await requestJson(endpoint('categories', { cnpj: category.cnpj }), { method: 'DELETE' });
      setMessage('Empresa excluída.', 'success');
      await loadCategories();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const createCategoryCard = (category) => {
    const card = document.createElement('details');
    card.className = 'category-card';
    const summary = document.createElement('summary');
    const company = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = category.name;
    const cnpj = document.createElement('small');
    cnpj.textContent = formatCnpj(category.cnpj);
    company.append(name, cnpj);
    const count = document.createElement('span');
    count.className = 'category-count';
    const enabledTotal = category.contacts.filter((contact) => contact.enabled !== false).length;
    count.textContent = enabledTotal === category.contacts.length
      ? `${enabledTotal} destinatário${enabledTotal === 1 ? '' : 's'}`
      : `${enabledTotal} de ${category.contacts.length} com envio`;
    summary.append(company, count);

    const content = document.createElement('div');
    content.className = 'category-content';
    const contacts = document.createElement('ul');
    contacts.className = 'contact-list';
    if (category.contacts.length) {
      contacts.append(...category.contacts.map((contact) => createContactItem(category, contact)));
    } else {
      const empty = document.createElement('li');
      empty.className = 'contact-list-empty';
      empty.textContent = 'Nenhum destinatário cadastrado.';
      contacts.appendChild(empty);
    }

    const form = document.createElement('form');
    form.className = 'collection-form contact-form';
    form.innerHTML = `
      <label>Primeiro nome
        <input name="firstName" type="text" autocomplete="given-name" maxlength="80" placeholder="Inferido pelo e-mail se vazio">
      </label>
      <label>Sobrenome (opcional)
        <input name="lastName" type="text" autocomplete="family-name" maxlength="120">
      </label>
      <label>E-mail
        <input name="email" type="email" autocomplete="email" maxlength="254" required>
      </label>
      <button class="button button-primary" type="submit">Adicionar pessoa</button>`;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveContact(category, form);
    });
    const removeCategory = document.createElement('button');
    removeCategory.type = 'button';
    removeCategory.className = 'button button-quiet danger-button';
    removeCategory.textContent = 'Excluir empresa';
    removeCategory.addEventListener('click', () => requestCategoryDeletion(category, removeCategory));
    const updateContacts = document.createElement('button');
    updateContacts.type = 'button';
    updateContacts.className = 'button button-quiet';
    updateContacts.textContent = 'Atualizar Contatos';
    updateContacts.addEventListener('click', () => syncContacts(category));
    const footer = document.createElement('div');
    footer.className = 'category-footer';
    footer.append(updateContacts, removeCategory);
    content.append(contacts, form, footer);
    card.append(summary, content);
    return card;
  };

  const renderCategories = (payload) => {
    state.categories = Array.isArray(payload.categories) ? payload.categories : [];
    elements.categoryList.replaceChildren(...state.categories.map(createCategoryCard));
    elements.categoryEmpty.hidden = state.categories.length > 0;
    elements.companyCount.textContent = String(payload.totals?.categories ?? state.categories.length);
    elements.contactCount.textContent = String(payload.totals?.contacts ?? state.categories.reduce(
      (total, category) => total + category.contacts.length,
      0
    ));
  };

  const loadCategories = async () => {
    renderCategories(await requestJson(endpoint('categories')));
  };

  const renderPending = (payload) => {
    const pending = Array.isArray(payload.pending) ? payload.pending : [];
    const reasons = {
      doccob: 'Aguardando DOCCOB',
      contacts: 'Sem destinatário cadastrado',
      processing_error: 'Falha no processamento'
    };
    const rows = pending.map((record) => {
      const row = document.createElement('tr');
      appendCell(row, record.invoiceId || '—').className = 'invoice-id';
      const client = appendCell(row, record.clientName || 'Não informado');
      const documentLine = document.createElement('small');
      documentLine.textContent = formatCnpj(record.clientCnpj);
      client.appendChild(documentLine);
      const reason = appendCell(row, reasons[record.reason] || 'Aguardando processamento');
      if (record.message) {
        const detail = document.createElement('small');
        detail.textContent = record.message;
        reason.appendChild(detail);
      }
      appendCell(row, formatDate(record.issuedAt));
      appendCell(row, formatDate(record.dueAt));
      appendCell(row, formatDateTime(record.lastCheckedAt));
      appendCell(row, record.lastCheckSource === 'automatic'
        ? 'Automática'
        : record.lastCheckSource === 'manual' ? 'Manual' : 'Não registrada');
      appendCell(row, String(record.attempts || 0));
      return row;
    });
    elements.pendingRows.replaceChildren(...rows);
    elements.pendingEmpty.hidden = pending.length > 0;
    elements.pendingCount.textContent = String(payload.doccobTotal ?? pending.filter(
      (record) => record.reason === 'doccob'
    ).length);
    if (elements.pendingRunStatus) {
      const lastRun = payload.lastRun;
      if (!lastRun) {
        elements.pendingRunStatus.textContent = 'Nenhuma execução registrada nesta versão. Use “Verificar agora” durante a etapa manual.';
      } else {
        const source = lastRun.source === 'automatic' ? 'automática' : 'manual';
        const status = lastRun.status === 'completed' ? 'concluída' : 'falhou';
        elements.pendingRunStatus.textContent = `Última execução ${source} ${status} em ${formatDateTime(lastRun.completedAt)}.`;
      }
    }
  };

  const loadPending = async () => renderPending(await requestJson(endpoint('pending')));

  const EVENT_LABELS = {
    initial: 'Envio inicial',
    reminder: 'Perto do vencimento',
    overdue: 'Fatura vencida'
  };
  const STATUS_LABELS = {
    accepted: 'Aguardando confirmação',
    submitted: 'Aguardando confirmação',
    delivered: 'Entregue ao servidor destinatário',
    soft_bounce: 'Falha temporária',
    hard_bounce: 'Falha definitiva',
    bounced: 'Entrega recusada',
    review: 'Requer conferência',
    error: 'Erro',
    waiting_contacts: 'Sem destinatário'
  };

  const renderLogs = (payload) => {
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    const rows = logs.map((record) => {
      const row = document.createElement('tr');
      appendCell(row, formatDateTime(record.createdAt));
      appendCell(row, record.invoiceId || '—').className = 'invoice-id';
      const client = appendCell(row, record.clientName || 'Não informado');
      const documentLine = document.createElement('small');
      documentLine.textContent = formatCnpj(record.clientCnpj);
      client.appendChild(documentLine);
      const recipient = appendCell(row, record.contactName || '—');
      const email = document.createElement('small');
      email.textContent = record.email || record.message || '';
      recipient.appendChild(email);
      appendCell(row, EVENT_LABELS[record.event] || record.event || '—');
      const status = appendCell(row, STATUS_LABELS[record.status] || record.status || '—');
      status.className = `collection-status status-${record.status || 'unknown'}`;
      if (record.message) status.title = record.message;
      const action = document.createElement('td');
      const previewButton = document.createElement('button');
      previewButton.type = 'button';
      previewButton.className = 'button button-quiet log-preview-button';
      previewButton.textContent = 'Visualizar';
      previewButton.addEventListener('click', () => openEmailLogModal(record, previewButton));
      action.appendChild(previewButton);
      row.appendChild(action);
      return row;
    });
    elements.logRows.replaceChildren(...rows);
    elements.logsEmpty.hidden = logs.length > 0;
    const pagination = payload.pagination || {};
    state.logPage = Math.max(1, Number(pagination.page) || 1);
    state.logTotalPages = Math.max(1, Number(pagination.totalPages) || 1);
    const total = Math.max(0, Number(payload.total) || 0);
    elements.previousLogPage.disabled = state.loading || !pagination.hasPrevious;
    elements.nextLogPage.disabled = state.loading || !pagination.hasNext;
    elements.logPageIndicator.textContent =
      `Página ${state.logPage} de ${state.logTotalPages} · ${total} registro${total === 1 ? '' : 's'}`;
  };

  const logFilters = () => {
    const data = new FormData(elements.logsForm);
    return Object.fromEntries([...data.entries()]
      .map(([key, value]) => [key, key === 'cnpj' ? String(value).replace(/\D/g, '') : String(value).trim()])
      .filter(([, value]) => value));
  };

  const loadLogs = async ({ filters = state.logFilters, page = state.logPage } = {}) => {
    const payload = await requestJson(endpoint('logs', {
      ...filters,
      page: String(page),
      limit: '10'
    }));
    state.logFilters = { ...filters };
    renderLogs(payload);
  };

  const loadCollection = async () => {
    if (state.loading) return;
    setLoading(true);
    setMessage('Carregando dados de cobrança…');
    try {
      await Promise.all([loadCategories(), loadPending(), loadLogs()]);
      state.loaded = true;
      setMessage('');
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const setArea = (area) => {
    const collection = area === 'collection';
    elements.invoiceWorkspace.hidden = collection;
    elements.collectionWorkspace.hidden = !collection;
    elements.areaButtons.forEach((button) => {
      const active = button.dataset.billingArea === area;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    elements.backToTopButton.hidden = true;
    if (collection && !state.loaded) loadCollection();
  };

  elements.areaButtons.forEach((button) => {
    button.addEventListener('click', () => setArea(button.dataset.billingArea));
  });

  elements.categoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(elements.categoryForm);
    setLoading(true);
    try {
      const result = await requestJson(endpoint('categories'), {
        method: 'POST',
        body: JSON.stringify({ cnpj: data.get('cnpj'), name: data.get('name') })
      });
      elements.categoryForm.reset();
      setMessage(result.message || 'Empresa salva.', 'success');
      await loadCategories();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  elements.logsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const filters = logFilters();
    setLoading(true);
    try {
      await loadLogs({ filters, page: 1 });
      setMessage('Logs atualizados.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  elements.clearLogsButton.addEventListener('click', async () => {
    elements.logsForm.reset();
    state.logFilters = {};
    state.logPage = 1;
    setLoading(true);
    try { await loadLogs({ filters: {}, page: 1 }); } catch (error) { setMessage(error.message, 'error'); }
    finally { setLoading(false); }
  });

  const changeLogPage = async (amount) => {
    const page = Math.max(1, Math.min(state.logPage + amount, state.logTotalPages));
    if (page === state.logPage) return;
    setLoading(true);
    try {
      await loadLogs({ page });
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  elements.previousLogPage.addEventListener('click', () => changeLogPage(-1));
  elements.nextLogPage.addEventListener('click', () => changeLogPage(1));

  elements.categoryDeleteBackdrop.addEventListener('click', closeCategoryDeleteModal);
  elements.cancelCategoryDelete.addEventListener('click', closeCategoryDeleteModal);
  elements.confirmCategoryDelete.addEventListener('click', async () => {
    const category = state.categoryToDelete;
    if (!category) return;
    closeCategoryDeleteModal();
    await deleteCategory(category);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.categoryDeleteModal.hidden) {
      closeCategoryDeleteModal();
    }
    if (event.key === 'Escape' && !elements.emailLogModal.hidden) {
      closeEmailLogModal();
    }
  });
  elements.emailLogBackdrop.addEventListener('click', closeEmailLogModal);
  elements.emailLogClose.addEventListener('click', closeEmailLogModal);

  elements.refreshPendingButton.addEventListener('click', async () => {
    setLoading(true);
    try {
      await loadPending();
      setMessage('Pendências atualizadas.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  elements.runButton.addEventListener('click', async () => {
    setLoading(true);
    setMessage('Conferindo faturas, documentos e envios…');
    try {
      const result = await requestJson(endpoint('process'), { method: 'POST' });
      await Promise.all([loadPending(), loadLogs()]);
      setMessage(
        `Verificação concluída: ${result.sent} e-mail(s) enviado(s), ${result.pendingDoccob} aguardando DOCCOB e ${result.errors.length} erro(s).`,
        result.errors.length ? 'warning' : 'success'
      );
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });
})();
