(() => {
  'use strict';

  const elements = {
    areaButtons: [...document.querySelectorAll('[data-billing-area]')],
    invoiceWorkspace: document.getElementById('invoiceWorkspace'),
    collectionWorkspace: document.getElementById('collectionWorkspace'),
    liquidationWorkspace: document.getElementById('liquidationWorkspace'),
    inactiveWorkspace: document.getElementById('inactiveWorkspace'),
    collectionSectionButtons: [...document.querySelectorAll('[data-collection-section]')],
    collectionSectionPanels: [...document.querySelectorAll('.collection-anchor-target')],
    message: document.getElementById('collectionMessage'),
    runButton: document.getElementById('runCollectionButton'),
    categorySearchForm: document.getElementById('categorySearchForm'),
    categorySearchInput: document.getElementById('categorySearchInput'),
    jointSearchForm: document.getElementById('jointBillingSearchForm'),
    jointMatches: document.getElementById('jointBillingMatches'),
    jointPreview: document.getElementById('jointBillingPreview'),
    jointCompany: document.getElementById('jointBillingCompany'),
    jointRecipients: document.getElementById('jointBillingRecipients'),
    jointTotal: document.getElementById('jointBillingTotal'),
    jointRows: document.getElementById('jointBillingRows'),
    jointRefreshButton: document.getElementById('refreshJointBillingButton'),
    jointSendButton: document.getElementById('sendJointBillingButton'),
    itauReconciliationPreviewForm: document.getElementById('itauReconciliationPreviewForm'),
    itauReconciliationInvoiceId: document.getElementById('itauReconciliationInvoiceId'),
    itauReconciliationPreviewResult: document.getElementById('itauReconciliationPreviewResult'),
    itauReconciliationRearmButton: document.getElementById('itauReconciliationRearmButton'),
    itauReconciliationRunButton: document.getElementById('itauReconciliationRunButton'),
    focusLiquidationButton: document.getElementById('focusLiquidationButton'),
    liquidationMessage: document.getElementById('liquidationMessage'),
    liquidationBatchIssues: document.getElementById('liquidationBatchIssues'),
    refreshLiquidationIssues: document.getElementById('refreshLiquidationIssues'),
    liquidationIssuesMessage: document.getElementById('liquidationIssuesMessage'),
    liquidationIssueRows: document.getElementById('liquidationIssueRows'),
    liquidationIssuesEmpty: document.getElementById('liquidationIssuesEmpty'),
    refreshLiquidationLog: document.getElementById('refreshLiquidationLog'),
    liquidationLogRows: document.getElementById('liquidationLogRows'),
    liquidationLogEmpty: document.getElementById('liquidationLogEmpty'),
    companyCount: document.getElementById('collectionCompanyCount'),
    contactCount: document.getElementById('collectionContactCount'),
    pendingCount: document.getElementById('collectionPendingCount'),
    categoryForm: document.getElementById('categoryForm'),
    categoryList: document.getElementById('categoryList'),
    categoryEmpty: document.getElementById('categoryEmpty'),
    pendingRows: document.getElementById('pendingRows'),
    pendingEmpty: document.getElementById('pendingEmpty'),
    pendingIssueSummary: document.getElementById('pendingIssueSummary'),
    pendingRunStatus: document.getElementById('pendingRunStatus'),
    refreshPendingButton: document.getElementById('refreshPendingButton'),
    logsForm: document.getElementById('collectionLogsForm'),
    clearLogsButton: document.getElementById('clearCollectionLogs'),
    logRows: document.getElementById('collectionLogRows'),
    logsEmpty: document.getElementById('collectionLogsEmpty'),
    previousLogPage: document.getElementById('previousLogPage'),
    nextLogPage: document.getElementById('nextLogPage'),
    logPageIndicator: document.getElementById('logPageIndicator'),
    paymentImportForm: document.getElementById('paymentImportForm'),
    paymentImportResult: document.getElementById('paymentImportResult'),
    paymentImportFilename: document.getElementById('paymentImportFilename'),
    paymentImportExpiration: document.getElementById('paymentImportExpiration'),
    paymentRowsCount: document.getElementById('paymentRowsCount'),
    paymentInvoicesCount: document.getElementById('paymentInvoicesCount'),
    paymentEligibleCount: document.getElementById('paymentEligibleCount'),
    paymentEligibleAmount: document.getElementById('paymentEligibleAmount'),
    paymentImportRows: document.getElementById('paymentImportRows'),
    paymentImportEmpty: document.getElementById('paymentImportEmpty'),
    paymentRejected: document.getElementById('paymentRejected'),
    paymentRejectedSummary: document.getElementById('paymentRejectedSummary'),
    paymentRejectedRows: document.getElementById('paymentRejectedRows'),
    approveAllPayments: document.getElementById('approveAllPayments'),
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
    area: 'invoices',
    loaded: false,
    loading: false,
    liquidationLogLoaded: false,
    liquidationLogLoading: false,
    liquidationIssuesLoaded: false,
    liquidationIssuesLoading: false,
    bulkCursor: '',
    bulkTotals: { checked: 0, settled: 0, alreadySettled: 0, pending: 0, errors: 0 },
    bulkIssues: [],
    collectionSection: 'collectionContactsSection',
    categories: [],
    pendingFilter: 'all',
    logFilters: {},
    logPage: 1,
    logTotalPages: 1,
    paymentImport: null,
    categoryToDelete: null,
    categoryDeleteTrigger: null,
    emailLogTrigger: null,
    jointPreview: null,
    jointInitialRetryCategory: null,
    jointSendRetry: false,
    jointExcludedIds: new Set()
  };
  const endpoint = (route, query = {}) => {
    const params = new URLSearchParams({ route, ...query });
    return `/api/faturamento/cobranca?${params}`;
  };

  const requestJson = async (url, options = {}) => {
    let response;
    try {
      response = await fetch(url, {
        credentials: 'same-origin',
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {})
        }
      });
    } catch (error) {
      throw new Error(`Falha de conexão com o servidor: ${error.message || 'sem resposta'}. Tente novamente.`);
    }
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const payload = isJson
      ? await response.json().catch(() => ({}))
      : {};
    if (!response.ok) {
      const requestId = response.headers.get('x-vercel-id');
      const fallback = response.status === 429
        ? 'Muitas consultas em sequência (HTTP 429). Aguarde um instante e tente novamente.'
        : `Não foi possível concluir a solicitação (HTTP ${response.status}${requestId
          ? `; requisição ${requestId}` : ''}).`;
      const serverMessage = String(payload.message || '').trim();
      const generic = /^Não foi possível concluir (?:a solicitação|a operação de cobrança)\.?$/i
        .test(serverMessage);
      const error = new Error(serverMessage && !generic ? serverMessage : fallback);
      error.status = response.status;
      error.retryable = payload.retryable === true;
      error.invoiceId = payload.invoiceId || '';
      error.retryStage = payload.retryStage || '';
      throw error;
    }
    if (!isJson || !payload || typeof payload !== 'object' || !Object.keys(payload).length) {
      throw new Error(`O servidor retornou uma resposta inválida (HTTP ${response.status}). Tente novamente.`);
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

  const formatMoney = (value) => new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(value) || 0);

  const appendCell = (row, value) => {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
  };

  const openInvoiceInWorkspace = (invoiceId) => {
    const normalizedId = String(invoiceId || '').replace(/\D/g, '');
    if (!normalizedId) return;
    const invoicesTab = elements.areaButtons.find((button) => button.dataset.billingArea === 'invoices');
    setArea('invoices');
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('billing:open-invoice-detail', {
        detail: { invoiceId: normalizedId, trigger: invoicesTab }
      }));
    });
  };

  const appendInvoiceNavigationCell = (row, invoiceId) => {
    const cell = document.createElement('td');
    cell.className = 'invoice-id';
    const normalizedId = String(invoiceId || '').replace(/\D/g, '');
    if (!normalizedId) {
      cell.textContent = '—';
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'invoice-detail-trigger';
      button.textContent = normalizedId;
      button.setAttribute('aria-label', `Abrir a fatura ${normalizedId}`);
      button.addEventListener('click', () => openInvoiceInWorkspace(normalizedId));
      cell.appendChild(button);
    }
    row.appendChild(cell);
    return cell;
  };

  const setMessage = (message, kind = '') => {
    const target = state.area === 'liquidation' ? elements.liquidationMessage : elements.message;
    target.textContent = message;
    target.dataset.kind = kind;
  };

  const setLoading = (loading) => {
    state.loading = loading;
    document.querySelectorAll('#collectionWorkspace button, #collectionWorkspace input, #collectionWorkspace select, '
      + '#liquidationWorkspace button, #liquidationWorkspace input, #liquidationWorkspace select').forEach((control) => {
      control.disabled = loading ||
        (control === elements.refreshLiquidationLog && state.liquidationLogLoading) ||
        (control === elements.refreshLiquidationIssues && state.liquidationIssuesLoading);
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
      const result = await requestJson(endpoint('contacts'), {
        method: 'PATCH',
        body: JSON.stringify({ cnpj: category.cnpj, id: contact.id, enabled })
      });
      setMessage(enabled ? 'Contato habilitado para envio.' : 'Contato desabilitado para envio.', 'success');
      return result.contact || { ...contact, enabled };
    } catch (error) {
      setMessage(error.message, 'error');
      return null;
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

  const createContactItem = (category, contact, onStatusChange) => {
    const item = document.createElement('li');
    item.className = 'contact-item';
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
    toggle.className = 'contact-send-toggle';
    const renderStatus = () => {
      const enabled = contact.enabled !== false;
      item.classList.toggle('is-disabled', !enabled);
      toggle.classList.toggle('is-enabled', enabled);
      toggle.classList.toggle('is-disabled', !enabled);
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.setAttribute('aria-label', `${enabled ? 'Desabilitar' : 'Habilitar'} envio para ${name.textContent}`);
      toggle.textContent = enabled ? 'Envio ✔️' : 'Envio ❌';
    };
    renderStatus();
    toggle.addEventListener('click', async () => {
      const saved = await setContactEnabled(category, contact, contact.enabled === false);
      if (!saved) return;
      Object.assign(contact, saved);
      renderStatus();
      onStatusChange();
    });
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

  const saveCategorySettings = async (category, form, card) => {
    const data = new FormData(form);
    setLoading(true);
    try {
      const result = await requestJson(endpoint('categories'), {
        method: 'PATCH',
        body: JSON.stringify({
          cnpj: category.cnpj,
          name: data.get('name'),
          billingMethod: data.get('billingMethod'),
          whiteMartins: data.get('whiteMartins') === 'on'
        })
      });
      const updated = result.category;
      const index = state.categories.findIndex((item) => item.cnpj === category.cnpj);
      if (index >= 0) state.categories[index] = updated;
      const replacement = createCategoryCard(updated);
      replacement.open = true;
      card.replaceWith(replacement);
      setMessage(result.message || 'Dados da empresa atualizados.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const createCategoryCard = (category) => {
    const card = document.createElement('details');
    card.className = 'category-card';
    card.dataset.cnpj = String(category.cnpj || '').replace(/\D/g, '');
    const summary = document.createElement('summary');
    const company = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = category.name;
    const metadata = document.createElement('span');
    metadata.className = 'category-company-meta';
    const cnpj = document.createElement('small');
    cnpj.textContent = formatCnpj(category.cnpj);
    const billingBadge = document.createElement('span');
    billingBadge.className = 'category-badge';
    billingBadge.textContent = category.billingMethod === 'ted_doc' ? 'TED/DOC' : 'Boleto';
    metadata.append(cnpj, billingBadge);
    if (category.whiteMartins === true) {
      const whiteMartinsBadge = document.createElement('span');
      whiteMartinsBadge.className = 'category-badge is-white-martins';
      whiteMartinsBadge.textContent = 'White Martins';
      metadata.appendChild(whiteMartinsBadge);
    }
    company.append(name, metadata);
    const count = document.createElement('span');
    count.className = 'category-count';
    const updateCounts = () => {
      const enabledTotal = category.contacts.filter((contact) => contact.enabled !== false).length;
      count.textContent = enabledTotal === category.contacts.length
        ? `${enabledTotal} destinatário${enabledTotal === 1 ? '' : 's'}`
        : `${enabledTotal} de ${category.contacts.length} com envio`;
      elements.contactCount.textContent = String(state.categories.reduce(
        (total, item) => total + item.contacts.filter((contact) => contact.enabled !== false).length,
        0
      ));
    };
    updateCounts();
    summary.append(company, count);

    const content = document.createElement('div');
    content.className = 'category-content';
    const contacts = document.createElement('ul');
    contacts.className = 'contact-list';
    if (category.contacts.length) {
      contacts.append(...category.contacts.map((contact) => createContactItem(category, contact, updateCounts)));
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

    const settingsForm = document.createElement('form');
    settingsForm.className = 'collection-form category-settings-form';
    settingsForm.hidden = true;
    settingsForm.innerHTML = `
      <label>Nome fantasia
        <input name="name" type="text" autocomplete="organization" maxlength="160" required>
      </label>
      <label>Forma de cobrança
        <select name="billingMethod" required>
          <option value="bank_slip">Boleto</option>
          <option value="ted_doc">Transferência TED/DOC</option>
        </select>
      </label>
      <label class="category-flag-field">
        <input name="whiteMartins" type="checkbox">
        <span>Empresa White Martins</span>
      </label>
      <button class="button button-primary" type="submit">Salvar alterações</button>
      <button class="button button-quiet" type="button" data-cancel-category-edit>Cancelar</button>`;
    settingsForm.elements.name.value = category.name;
    settingsForm.elements.billingMethod.value = category.billingMethod || 'bank_slip';
    settingsForm.elements.whiteMartins.checked = category.whiteMartins === true;
    settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      saveCategorySettings(category, settingsForm, card);
    });
    settingsForm.querySelector('[data-cancel-category-edit]').addEventListener('click', () => {
      settingsForm.hidden = true;
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
    const editCategory = document.createElement('button');
    editCategory.type = 'button';
    editCategory.className = 'button button-quiet';
    editCategory.textContent = 'Editar empresa';
    editCategory.addEventListener('click', () => {
      settingsForm.hidden = !settingsForm.hidden;
      if (!settingsForm.hidden) settingsForm.elements.name.focus();
    });
    const footer = document.createElement('div');
    footer.className = 'category-footer';
    const footerActions = document.createElement('div');
    footerActions.className = 'category-footer-actions';
    footerActions.append(updateContacts, editCategory);
    footer.append(footerActions, removeCategory);
    content.append(contacts, form, settingsForm, footer);
    card.append(summary, content);
    return card;
  };

  const renderCategories = (payload) => {
    state.categories = Array.isArray(payload.categories) ? payload.categories : [];
    elements.categoryList.replaceChildren(...state.categories.map(createCategoryCard));
    elements.categoryEmpty.hidden = state.categories.length > 0;
    elements.companyCount.textContent = String(payload.totals?.categories ?? state.categories.length);
    elements.contactCount.textContent = String(payload.totals?.contacts ?? state.categories.reduce(
      (total, category) => total + category.contacts.filter((contact) => contact.enabled !== false).length,
      0
    ));
  };

  const loadCategories = async () => {
    renderCategories(await requestJson(endpoint('categories')));
  };

  const searchKey = (value) => String(value || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
  const matchingCategories = (term) => {
    const normalized = searchKey(term);
    const numeric = String(term || '').replace(/\D/g, '');
    return state.categories.filter((category) =>
      searchKey(category.name).includes(normalized)
      || (numeric.length >= 3 && String(category.cnpj).includes(numeric)));
  };

  const selectedJointInvoices = () => (state.jointPreview?.invoices || [])
    .filter((invoice) => !state.jointExcludedIds.has(invoice.id)
      && !invoice.jointSent && !invoice.sendReview);
  const needsJointInvoiceData = (invoice) => !invoice.jointSent && !invoice.sendReview
    && !invoice.blockKind && (invoice.unverified
      || (!invoice.blocked && (!invoice.proof || !invoice.snapshot)));
  const blocksJointSend = (invoice) => invoice.jointSent || invoice.sendReview
    || (invoice.blocked && (!invoice.unverified || invoice.blockKind));
  const jointBlockLabel = (invoice) => {
    const reasons = [];
    if (invoice.blockKind === 'manual') reasons.push('bloqueio manual');
    if (invoice.blockKind === 'bank_reconciliation') reasons.push('pendência de liquidação bancária');
    if (invoice.unverified) reasons.push('situação não confirmada na Brudam');
    if (invoice.jointSent) reasons.push('já enviada em conjunto');
    if (invoice.sendReview) reasons.push('resultado do envio exige conferência nos logs');
    return `${invoice.id} (${reasons.join(' e ') || 'envio bloqueado'})`;
  };

  const updateJointSelection = () => {
    if (state.jointInitialRetryCategory) {
      elements.jointTotal.textContent = 'Lista ainda não carregada';
      elements.jointRefreshButton.disabled = true;
      elements.jointSendButton.textContent = 'Tentar novamente';
      elements.jointSendButton.disabled = state.loading;
      return;
    }
    const selected = selectedJointInvoices();
    const needsRetry = selected.some((invoice) => invoice.prepareError);
    const total = selected.reduce((sum, invoice) => sum + (Number(invoice.balance) || 0), 0);
    elements.jointTotal.textContent = `${selected.length} selecionada(s) · Total: ${formatMoney(total)}`;
    const errorCount = selected.filter(needsJointInvoiceData).length;
    elements.jointRefreshButton.disabled = state.loading || errorCount === 0;
    elements.jointRefreshButton.title = errorCount
      ? `Reconsultar somente ${errorCount} fatura(s) com erro` : 'Nenhuma fatura com erro para atualizar';
    elements.jointSendButton.textContent = needsRetry || state.jointSendRetry
      ? 'Tentar novamente' : 'Enviar cobrança conjunta';
    elements.jointSendButton.disabled = state.loading || !selected.length
      || !state.jointPreview?.recipients?.length || selected.some(blocksJointSend);
  };

  const renderJointPreview = (preview) => {
    state.jointPreview = preview;
    elements.jointPreview.hidden = false;
    elements.jointCompany.textContent = `${preview.company.name} · ${formatCnpj(preview.company.cnpj)}`;
    elements.jointRecipients.textContent = `${preview.recipients.length} destinatário(s) ativo(s)`;
    elements.jointRows.replaceChildren(...preview.invoices.map((invoice) => {
      const row = document.createElement('tr');
      const ignored = state.jointExcludedIds.has(invoice.id);
      if (ignored) row.classList.add('joint-billing-ignored');
      appendInvoiceNavigationCell(row, invoice.id);
      appendCell(row, formatDate(invoice.issuedAt));
      appendCell(row, formatDate(invoice.dueAt));
      appendCell(row, invoice.balance == null ? 'Não confirmado' : formatMoney(invoice.balance));
      const status = appendCell(row, invoice.sendReview ? 'Conferir envio nos logs'
        : invoice.jointSent ? 'Já enviado em conjunto'
          : invoice.blocked ? 'Bloqueado'
          : invoice.prepareError ? 'Erro nos anexos'
            : invoice.preparedToken ? 'Anexos prontos' : 'Disponível');
      if (invoice.blockReason || invoice.prepareError) {
        const reason = document.createElement('small');
        reason.textContent = invoice.prepareError || invoice.blockReason;
        status.appendChild(reason);
      }
      const action = document.createElement('td');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'button button-quiet';
      toggle.disabled = state.loading || invoice.jointSent || invoice.sendReview;
      toggle.textContent = invoice.sendReview ? 'Conferir nos logs'
        : invoice.jointSent ? 'Já enviada'
          : ignored ? 'Incluir neste envio' : 'Ignorar neste envio';
      toggle.setAttribute('aria-pressed', String(ignored));
      toggle.addEventListener('click', () => {
        if (state.jointExcludedIds.has(invoice.id)) state.jointExcludedIds.delete(invoice.id);
        else state.jointExcludedIds.add(invoice.id);
        renderJointPreview(preview);
      });
      action.appendChild(toggle);
      row.appendChild(action);
      return row;
    }));
    updateJointSelection();
    const selected = selectedJointInvoices();
    if (!preview.invoices.length) {
      setMessage('Esta empresa não possui faturas em aberto vencidas há pelo menos dois dias.', 'warning');
    } else if (!selected.length) {
      setMessage('Nenhuma fatura apta selecionada. Faturas já enviadas não entram novamente na cobrança.', 'warning');
    } else if (selected.some(blocksJointSend)) {
      const blocked = selected.filter(blocksJointSend);
      setMessage(`Faturas que impedem o envio: ${blocked.map(jointBlockLabel).join('; ')}. `
        + 'Ignore-as neste envio para continuar com as demais.', 'warning');
    } else if (selected.some(needsJointInvoiceData)) {
      const pending = selected.filter(needsJointInvoiceData);
      setMessage(`${pending.length} fatura(s) sem confirmação: ${pending.map(jointBlockLabel).join('; ')}. `
        + 'Ao enviar, elas serão consultadas novamente em uma fila de espera sem travar as demais.', 'warning');
    } else if (selected.some((invoice) => invoice.prepareError)) {
      const pending = selected.filter((invoice) => invoice.prepareError);
      setMessage(`${pending.length} fatura(s) com anexo pendente: ${pending.map((invoice) =>
        `${invoice.id} (${invoice.prepareError})`).join('; ')}. `
        + 'Ao enviar, somente elas serão preparadas novamente.', 'warning');
    } else if (!preview.recipients.length) {
      setMessage('Cadastre ao menos um destinatário ativo antes de enviar.', 'warning');
    } else if (selected.some((invoice) => !invoice.proof)) {
      setMessage('A liberação de uma fatura está incompleta. Busque as faturas novamente antes de enviar.', 'warning');
    } else {
      setMessage(`${selected.length} fatura(s) selecionada(s) para envio. Confira antes de continuar.`, 'success');
    }
  };

  const retryJointErrors = async (preview) => {
    const errorIds = selectedJointInvoices().filter(needsJointInvoiceData)
      .map((invoice) => invoice.id);
    if (!errorIds.length || state.loading) return;
    let updated = 0;
    let removed = 0;
    let limited = false;
    let next = 0;
    let completed = 0;
    setLoading(true);
    updateJointSelection();
    try {
      const worker = async () => {
        while (next < errorIds.length && state.jointPreview === preview) {
          const id = errorIds[next++];
          let result;
          try {
            result = await requestJson(endpoint('joint-billing-refresh'), {
              method: 'POST',
              body: JSON.stringify({ cnpj: preview.company.cnpj, invoiceId: id,
                includePdfData: true })
            });
            if (result.id !== id || (!result.removed && !result.invoice)) {
              throw new Error(`Resposta inválida ao consultar a fatura ${id}.`);
            }
          } catch (error) {
            result = { id, removed: false, invoice: {
              id, balance: null, unverified: true, blocked: true, proof: null,
              upstreamStatus: error.status || null,
              blockReason: `Não foi possível consultar a fatura ${id}: ${error.message}`
            } };
          }
          if (result.removed) {
            preview.invoices = preview.invoices.filter((invoice) => invoice.id !== id);
            state.jointExcludedIds.delete(id);
            removed += 1;
          } else {
            preview.invoices = preview.invoices.map((invoice) => invoice.id === id
              ? { ...invoice, ...result.invoice,
                preparedToken: null, prepareError: null,
                issuedAt: result.invoice.issuedAt || invoice.issuedAt,
                dueAt: result.invoice.dueAt || invoice.dueAt }
              : invoice);
            if (!result.invoice.unverified) updated += 1;
            limited ||= result.invoice.upstreamStatus === 429;
          }
          completed += 1;
          setMessage(`Faturas conferidas: ${completed}/${errorIds.length} (${updated} confirmadas, `
            + `${removed} removidas).`);
          if (next < errorIds.length) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, errorIds.length) }, () => worker()));
      preview.totalBalance = Math.round(preview.invoices.reduce(
        (sum, invoice) => sum + (Number(invoice.balance) || 0), 0) * 100) / 100;
      preview.blockedCount = preview.invoices.filter((invoice) => invoice.blocked).length;
      preview.jointSentCount = preview.invoices.filter((invoice) => invoice.jointSent).length;
      renderJointPreview(preview);
      const remaining = selectedJointInvoices().filter(needsJointInvoiceData).length;
      const blocked = selectedJointInvoices().filter((invoice) => !needsJointInvoiceData(invoice)
        && (invoice.blocked || invoice.jointSent)).length;
      const summary = `${updated} fatura(s) confirmada(s), ${removed} removida(s) e ${remaining} ainda sem confirmação.`;
      setMessage(limited
        ? `${summary} A Brudam limitou parte das consultas (HTTP 429). Tente novamente mais tarde apenas as que falharam; as demais foram mantidas nesta página.`
        : `${summary}${remaining ? ' Clique em Tentar novamente para consultar só as que falharam.' : ''}`
          + `${blocked ? ` ${blocked} fatura(s) bloqueada(s) precisam ser ignoradas neste envio.` : ''}`,
      remaining || blocked ? 'warning' : 'success');
    } finally {
      setLoading(false);
      updateJointSelection();
    }
  };

  const prepareJointInvoice = async (preview, invoice) => {
    const refresh = async () => {
      const result = await requestJson(endpoint('joint-billing-refresh'), {
        method: 'POST',
        body: JSON.stringify({ cnpj: preview.company.cnpj, invoiceId: invoice.id,
          includePdfData: true })
      });
      if (result.id !== invoice.id || (!result.removed && !result.invoice)) {
        throw new Error(`Resposta inválida ao atualizar a fatura ${invoice.id}.`);
      }
      if (result.removed) {
        preview.invoices = preview.invoices.filter((item) => item.id !== invoice.id);
        state.jointExcludedIds.delete(invoice.id);
        invoice.removed = true;
        throw new Error(`A fatura ${invoice.id} deixou de estar aberta e não será enviada.`);
      }
      Object.assign(invoice, result.invoice, {
        issuedAt: result.invoice.issuedAt || invoice.issuedAt,
        dueAt: result.invoice.dueAt || invoice.dueAt,
        preparedToken: null, preparedBytes: null, prepareError: null
      });
      if (invoice.unverified || invoice.blocked || invoice.jointSent || !invoice.proof || !invoice.snapshot) {
        throw Object.assign(new Error(invoice.blockReason
          || `A fatura ${invoice.id} não foi liberada pela Brudam.`), {
          retryStage: 'refresh', status: invoice.upstreamStatus || undefined,
          retryable: !invoice.blockKind && !invoice.jointSent
        });
      }
    };
    if (invoice.unverified || !invoice.snapshot || window.jointProofNeedsRefresh(invoice.proof)) {
      await refresh();
    }
    if (invoice.preparedToken && Number.isSafeInteger(invoice.preparedBytes)) {
      return invoice.preparedBytes;
    }
    const prepare = () => requestJson(endpoint('joint-billing-prepare'), {
      method: 'POST',
      body: JSON.stringify({ cnpj: preview.company.cnpj, invoiceId: invoice.id,
        proof: invoice.proof, snapshot: invoice.snapshot })
    });
    let result;
    try {
      result = await prepare();
    } catch (error) {
      if (error.retryStage !== 'refresh') throw error;
      await refresh();
      result = await prepare();
    }
    if (result.id !== invoice.id || !result.token
      || !Number.isSafeInteger(result.totalBytes) || result.totalBytes <= 0) {
      throw new Error(`Resposta inválida ao preparar a fatura ${invoice.id}.`);
    }
    invoice.preparedToken = result.token;
    invoice.preparedBytes = result.totalBytes;
    invoice.prepareError = null;
    return result.totalBytes;
  };

  const loadJointCompany = async (category) => {
    if (state.loading) return;
    state.jointInitialRetryCategory = null;
    state.jointSendRetry = false;
    setLoading(true);
    setMessage(`Buscando faturas vencidas em aberto de ${category.name}…`);
    elements.jointPreview.hidden = true;
    state.jointPreview = null;
    state.jointExcludedIds.clear();
    let listed = false;
    try {
      const preview = await requestJson(endpoint('joint-billing', { cnpj: category.cnpj, list: '1' }));
      renderJointPreview(preview);
      listed = true;
    } catch (error) {
      if (!listed) {
        state.jointInitialRetryCategory = category;
        elements.jointPreview.hidden = false;
        elements.jointCompany.textContent = `${category.name} · ${formatCnpj(category.cnpj)}`;
        elements.jointRecipients.textContent = '';
        elements.jointRows.replaceChildren();
      }
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
      updateJointSelection();
    }
  };

  const renderPending = (payload) => {
    const allIssues = Array.isArray(payload.issues) ? payload.issues : [];
    const issues = state.pendingFilter === 'all'
      ? allIssues
      : allIssues.filter((record) => (
        state.pendingFilter === 'critical'
          ? record.priority === 'critical'
          : record.type === state.pendingFilter
      ));
    const priorityLabels = {
      critical: 'Crítica',
      high: 'Alta',
      medium: 'Média'
    };
    const actionLabels = {
      contacts: 'Ver contatos',
      logs: 'Ver logs',
      documents: 'Conferir documentos',
      payment: 'Conferir boleto',
      invoice: 'Ver detalhes'
    };
    const rows = issues.map((record) => {
      const row = document.createElement('tr');
      appendInvoiceNavigationCell(row, record.invoiceId);
      const client = appendCell(row, record.clientName || 'Não informado');
      const documentLine = document.createElement('small');
      documentLine.textContent = formatCnpj(record.clientCnpj);
      client.appendChild(documentLine);
      const reason = appendCell(row, record.title || 'Aguardando processamento');
      if (record.message) {
        const detail = document.createElement('small');
        detail.textContent = record.message;
        reason.appendChild(detail);
      }
      const priority = appendCell(row, priorityLabels[record.priority] || 'Média');
      priority.className = `issue-priority priority-${record.priority || 'medium'}`;
      appendCell(row, formatDate(record.dueAt));
      appendCell(row, formatDateTime(record.updatedAt));
      const actionCell = document.createElement('td');
      const actionButtons = document.createElement('div');
      actionButtons.className = 'pending-row-actions';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'button button-quiet issue-action';
      action.textContent = actionLabels[record.action] || 'Conferir';
      action.addEventListener('click', (event) => navigateIssue(record, event.currentTarget));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button danger-button issue-remove';
      remove.textContent = 'Remover';
      remove.addEventListener('click', async () => {
        if (!window.confirm(
          `Remover somente a pendência da fatura ${record.invoiceId}? O log será preservado e a pendência poderá reaparecer se houver uma nova ocorrência.`
        )) return;
        remove.disabled = true;
        setLoading(true);
        try {
          const result = await requestJson(endpoint('pending'), {
            method: 'DELETE',
            body: JSON.stringify({ id: record.id })
          });
          await loadPending();
          setMessage(result.message || 'Pendência removida.', 'success');
        } catch (error) {
          setMessage(error.message, 'error');
          remove.disabled = false;
        } finally {
          setLoading(false);
        }
      });
      actionButtons.append(action, remove);
      actionCell.appendChild(actionButtons);
      row.appendChild(actionCell);
      return row;
    });
    elements.pendingRows.replaceChildren(...rows);
    elements.pendingEmpty.hidden = issues.length > 0;
    const emptyTitle = elements.pendingEmpty.querySelector('strong');
    const emptyDescription = elements.pendingEmpty.querySelector('p');
    if (state.pendingFilter === 'all') {
      emptyTitle.textContent = 'Nenhuma pendência aberta';
      emptyDescription.textContent = 'Documentos, contatos, pagamentos e entregas estão sem alertas registrados.';
    } else {
      emptyTitle.textContent = 'Nenhuma pendência neste filtro';
      emptyDescription.textContent = 'Selecione outro tipo para conferir as demais ações abertas.';
    }
    elements.pendingCount.textContent = String(payload.total ?? allIssues.length);
    const summary = payload.summary || {};
    const summaryItems = [
      ['Todas', payload.total ?? allIssues.length, 'all'],
      ['Críticas', summary.critical || 0, 'critical'],
      ['Documentos', summary.documents || 0, 'documents'],
      ['Contatos', summary.contacts || 0, 'contacts'],
      ['E-mail', summary.email || 0, 'email'],
      ['Pagamento', summary.payment || 0, 'payment']
    ];
    elements.pendingIssueSummary.replaceChildren(...summaryItems.map(([label, count, type]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pending-summary-filter';
      item.dataset.type = type;
      item.setAttribute('aria-pressed', String(state.pendingFilter === type));
      item.textContent = `${label}: ${count}`;
      item.addEventListener('click', () => {
        state.pendingFilter = type;
        renderPending(payload);
      });
      return item;
    }));
    if (elements.pendingRunStatus) {
      const lastRun = payload.lastRun;
      if (!lastRun) {
        elements.pendingRunStatus.textContent = 'Nenhuma execução registrada nesta versão. Use “Verificar agora” durante a etapa manual.';
      } else {
        const source = lastRun.source === 'automatic' ? 'automática' : 'manual';
        const status = lastRun.status === 'completed' ? 'concluída' : 'falhou';
        const continuation = lastRun.stoppedByLimit
          ? ` ${lastRun.remaining || 0} fatura(s) ficaram para a próxima rodada.`
          : '';
        elements.pendingRunStatus.textContent = `Última execução ${source} ${status} em ${formatDateTime(lastRun.completedAt)}.${continuation}`;
      }
    }
  };

  const navigateIssue = async (record, trigger) => {
    if (record.action === 'contacts') {
      setCollectionSection('collectionContactsSection');
      const category = elements.categoryList.querySelector(
        `[data-cnpj="${String(record.clientCnpj || '').replace(/\D/g, '')}"]`
      );
      if (category) {
        category.open = true;
        category.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        setMessage('Cadastre esta empresa para incluir destinatários de cobrança.', 'warning');
        elements.categoryForm.elements.cnpj.value = formatCnpj(record.clientCnpj);
        elements.categoryForm.elements.name.value = record.clientName === 'Não informado' ? '' : record.clientName;
        elements.categoryForm.elements.name.focus();
      }
      return;
    }
    if (record.action === 'logs') {
      setCollectionSection('collectionLogsSection');
      elements.logsForm.elements.invoiceId.value = record.invoiceId || '';
      setLoading(true);
      try {
        await loadLogs({ filters: { invoiceId: String(record.invoiceId || '') }, page: 1 });
      } catch (error) {
        setMessage(error.message, 'error');
      } finally {
        setLoading(false);
      }
      return;
    }
    if (record.action === 'documents' || record.action === 'payment') {
      window.dispatchEvent(new CustomEvent('billing:open-documents', {
        detail: { invoiceId: record.invoiceId, trigger }
      }));
      return;
    }
    window.dispatchEvent(new CustomEvent('billing:open-invoice-detail', {
      detail: { invoiceId: record.invoiceId, trigger }
    }));
  };

  const loadPending = async () => renderPending(await requestJson(endpoint('pending')));

  const EVENT_LABELS = {
    initial: 'Envio inicial',
    reminder: 'Perto do vencimento',
    overdue: 'Fatura vencida',
    joint: 'Envio em conjunto'
  };
  const STATUS_LABELS = {
    accepted: 'Aguardando confirmação',
    submitted: 'Aguardando confirmação',
    delivered: 'Entregue ao servidor destinatário',
    soft_bounce: 'Falha temporária',
    hard_bounce: 'Falha definitiva',
    bounced: 'Entrega recusada',
    review: 'Requer conferência',
    not_sent: 'Não enviado — confirmação corrigida',
    error: 'Erro',
    waiting_contacts: 'Sem destinatário',
    resolved: 'Resolvido manualmente'
  };
  const RESOLVABLE_LOG_STATUSES = new Set([
    'soft_bounce', 'hard_bounce', 'bounced', 'review', 'error', 'waiting_contacts'
  ]);

  const logErrorMessage = (record) => {
    const message = String(record.message || '');
    if (record.status === 'hard_bounce'
      && /bad-mailbox/i.test(message)
      && /user\s+not\s+found|no\s+such\s+user\s+here/i.test(message)) {
      return 'Usuario nao encontrado';
    }
    return message;
  };

  const renderLogs = (payload) => {
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    const rows = logs.map((record) => {
      const row = document.createElement('tr');
      appendCell(row, formatDateTime(record.createdAt));
      appendInvoiceNavigationCell(row, record.invoiceId);
      const client = appendCell(row, record.clientName || 'Não informado');
      const documentLine = document.createElement('small');
      documentLine.textContent = formatCnpj(record.clientCnpj);
      client.appendChild(documentLine);
      const recipient = appendCell(row, record.contactName || '—');
      const email = document.createElement('small');
      email.textContent = record.email || record.message || '';
      recipient.appendChild(email);
      appendCell(row, record.manualResend
        ? 'Reenvio manual'
        : EVENT_LABELS[record.event] || record.event || '—');
      const retryable = record.status === 'error' && record.retryable === true;
      const status = appendCell(row, retryable
        ? 'Não enviado — nova tentativa pendente'
        : STATUS_LABELS[record.status] || record.status || '—');
      status.className = `collection-status status-${record.status || 'unknown'}`;
      const errorMessage = logErrorMessage(record);
      if (errorMessage) status.title = errorMessage;
      if ((retryable || record.status === 'review' || record.legacyReview
        || (record.status === 'hard_bounce' && errorMessage === 'Usuario nao encontrado')) && errorMessage) {
        const detail = document.createElement('small');
        detail.textContent = errorMessage;
        status.appendChild(detail);
      }
      const action = document.createElement('td');
      const actionButtons = document.createElement('div');
      actionButtons.className = 'collection-log-actions';
      const previewButton = document.createElement('button');
      previewButton.type = 'button';
      previewButton.className = 'button button-quiet log-preview-button';
      previewButton.textContent = 'Visualizar';
      previewButton.addEventListener('click', () => openEmailLogModal(record, previewButton));
      const resolveButton = document.createElement('button');
      resolveButton.type = 'button';
      resolveButton.className = 'button button-quiet log-resolve-button';
      resolveButton.textContent = 'Marcar resolvido';
      resolveButton.disabled = !record.id;
      resolveButton.addEventListener('click', async () => {
        if (!record.id || !window.confirm(
          'Marcar esta ocorrência como resolvida? Isso apenas encerra o alerta: não reenvia o e-mail nem libera uma tentativa bloqueada.'
        )) return;
        resolveButton.disabled = true;
        setLoading(true);
        try {
          const result = await requestJson(endpoint('logs'), {
            method: 'PATCH',
            body: JSON.stringify({ id: record.id })
          });
          await Promise.all([
            loadLogs({ page: state.logPage }),
            loadPending()
          ]);
          setMessage(result.message || 'Ocorrência marcada como resolvida.', 'success');
        } catch (error) {
          setMessage(error.message, 'error');
          resolveButton.disabled = false;
        } finally {
          setLoading(false);
        }
      });
      actionButtons.append(previewButton);
      if (record.jointBilling && record.status === 'review' && record.clientReference) {
        const confirmDeliveryButton = document.createElement('button');
        confirmDeliveryButton.type = 'button';
        confirmDeliveryButton.className = 'button button-quiet log-confirm-delivery-button';
        confirmDeliveryButton.textContent = 'Confirmar entrega no provedor';
        confirmDeliveryButton.addEventListener('click', async () => {
          const invoiceCount = Array.isArray(record.invoiceIds) ? record.invoiceIds.length : 0;
          const recipientCount = String(record.email || '').split(',').filter(Boolean).length;
          if (confirmDeliveryButton.dataset.confirmPending !== 'true') {
            confirmDeliveryButton.dataset.confirmPending = 'true';
            confirmDeliveryButton.textContent = `Confirmar ${invoiceCount} fatura(s) para ${recipientCount} destinatário(s) · sem reenvio`;
            return;
          }
          confirmDeliveryButton.disabled = true;
          setLoading(true);
          try {
            await requestJson(endpoint('joint-delivery-confirm'), {
              method: 'POST',
              body: JSON.stringify({ clientReference: record.clientReference, confirmAllRecipients: true })
            });
            await loadLogs({ page: state.logPage });
            setMessage('Entrega registrada após conferência no provedor; nenhum e-mail foi reenviado.', 'success');
          } catch (error) {
            setMessage(error.message, 'error');
            confirmDeliveryButton.disabled = false;
          } finally {
            setLoading(false);
          }
        });
        actionButtons.append(confirmDeliveryButton);
      }
      if (record.jointBilling && record.status === 'delivered'
        && record.confirmationSource === 'provider_panel' && record.clientReference) {
        const retractButton = document.createElement('button');
        retractButton.type = 'button';
        retractButton.className = 'button button-quiet';
        retractButton.textContent = 'Corrigir confirmação';
        retractButton.addEventListener('click', async () => {
          const invoiceCount = Array.isArray(record.invoiceIds) ? record.invoiceIds.length : 0;
          if (retractButton.dataset.confirmPending !== 'true') {
            retractButton.dataset.confirmPending = 'true';
            retractButton.textContent = `Confirmar: referência ausente no provedor · liberar ${invoiceCount} fatura(s)`;
            return;
          }
          retractButton.disabled = true;
          setLoading(true);
          try {
            await requestJson(endpoint('joint-delivery-retract'), {
              method: 'POST',
              body: JSON.stringify({ clientReference: record.clientReference,
                confirmProviderReferenceAbsent: true })
            });
            await loadLogs({ page: state.logPage });
            setMessage('Confirmação corrigida; as faturas foram liberadas para nova conferência antes do envio.', 'success');
          } catch (error) {
            setMessage(error.message, 'error');
            retractButton.disabled = false;
          } finally {
            setLoading(false);
          }
        });
        actionButtons.append(retractButton);
      }
      if (RESOLVABLE_LOG_STATUSES.has(record.status) && !retryable) actionButtons.append(resolveButton);
      action.appendChild(actionButtons);
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

  const paymentStatus = (candidate) => {
    if (candidate.status === 'liquidated') return ['Liquidada', 'delivered'];
    if (candidate.status === 'already_settled') return ['Já estava liquidada', 'delivered'];
    if (candidate.status === 'error') return ['Falha na aprovação', 'error'];
    if (candidate.status === 'busy') return ['Em processamento', 'review'];
    if (candidate.eligible && candidate.status === 'ready') return ['Apta para liquidar', 'delivered'];
    return ['Requer conferência', 'review'];
  };

  const renderPaymentImport = (record) => {
    state.paymentImport = record;
    elements.paymentImportResult.hidden = !record;
    if (!record) return;
    const summary = record.summary || {};
    elements.paymentImportFilename.textContent = record.filename || 'Importação analisada';
    elements.paymentImportExpiration.textContent = `Analisada em ${formatDateTime(record.createdAt)} · prévia válida por 24 horas`;
    elements.paymentRowsCount.textContent = String(summary.spreadsheetRows || 0);
    elements.paymentInvoicesCount.textContent = String(summary.invoices || 0);
    elements.paymentEligibleCount.textContent = String(summary.eligibleInvoices || 0);
    elements.paymentEligibleAmount.textContent = formatMoney(summary.eligibleAmount);
    elements.approveAllPayments.disabled = state.loading || Number(summary.eligibleInvoices || 0) === 0;

    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const rows = candidates.map((candidate) => {
      const row = document.createElement('tr');
      appendInvoiceNavigationCell(row, candidate.invoiceId);
      const client = appendCell(row, candidate.clientName || 'Não informado');
      const cnpj = document.createElement('small');
      cnpj.textContent = formatCnpj(candidate.clientCnpj);
      client.appendChild(cnpj);
      const references = appendCell(row, (candidate.references || []).join(', ') || '—');
      references.className = 'payment-reference-cell';
      appendCell(row, formatDate(candidate.paymentDate));
      appendCell(row, formatMoney(candidate.importedAmount));
      appendCell(row, candidate.balance === null || candidate.balance === undefined
        ? '—' : formatMoney(candidate.balance));
      const [label, kind] = paymentStatus(candidate);
      const verification = appendCell(row, label);
      verification.className = `collection-status status-${kind}`;
      if (candidate.reason) {
        const detail = document.createElement('small');
        detail.textContent = candidate.reason;
        verification.appendChild(detail);
      }
      const action = document.createElement('td');
      if (candidate.eligible && ['ready', 'error'].includes(candidate.status)) {
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'button button-primary payment-approve-button';
        approve.textContent = candidate.status === 'error' ? 'Tentar novamente' : 'Aprovar';
        approve.addEventListener('click', () => approvePayments([candidate.invoiceId]));
        action.appendChild(approve);
      } else {
        action.textContent = candidate.status === 'liquidated' || candidate.status === 'already_settled'
          ? 'Concluída' : 'Indisponível';
      }
      row.appendChild(action);
      return row;
    });
    elements.paymentImportRows.replaceChildren(...rows);
    elements.paymentImportEmpty.hidden = candidates.length > 0;

    const rejected = Array.isArray(record.rejectedRows) ? record.rejectedRows : [];
    elements.paymentRejected.hidden = rejected.length === 0;
    elements.paymentRejectedSummary.textContent = `${rejected.length} linha(s) que exigem correção`;
    elements.paymentRejectedRows.replaceChildren(...rejected.map((item) => {
      const row = document.createElement('li');
      row.textContent = `Linha ${item.row || '—'}${item.reference ? ` · ${item.reference}` : ''}: ${item.message}`;
      return row;
    }));
  };

  const fileAsBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '').split(',').pop() || ''));
    reader.addEventListener('error', () => reject(new Error('Não foi possível ler o arquivo selecionado.')));
    reader.readAsDataURL(file);
  });

  async function approvePayments(invoiceIds = null) {
    const record = state.paymentImport;
    if (!record?.id) return;
    const selectedIds = invoiceIds ? new Set(invoiceIds.map(String)) : null;
    const selected = (record.candidates || []).filter((candidate) =>
      candidate.eligible && ['ready', 'error'].includes(candidate.status) &&
        (!selectedIds || selectedIds.has(String(candidate.invoiceId))));
    const count = selected.length;
    const total = selected.reduce((amount, candidate) => amount + Number(candidate.importedAmount || 0), 0);
    if (!count || !window.confirm(
      `Confirmar a liquidação de ${count} fatura(s), no total de ${formatMoney(total)}, na Brudam? Esta ação altera o financeiro.`
    )) return;
    setLoading(true);
    try {
      const result = await requestJson(endpoint('payment-import'), {
        method: 'PATCH',
        body: JSON.stringify({ importId: record.id, ...(invoiceIds ? { invoiceIds } : {}) })
      });
      renderPaymentImport(result.import);
      await loadPending();
      await loadLiquidationLog();
      setMessage(result.message || 'Aprovação concluída.', result.results?.some(
        (item) => item.status === 'error' || item.status === 'busy'
      ) ? 'warning' : 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
      renderPaymentImport(state.paymentImport);
    }
  }

  const renderLiquidationLog = (entries) => {
    const sourceNames = {
      itau: 'Boleto Itaú',
      bradesco: 'Boleto Bradesco',
      white_martins_spreadsheet: 'Planilha White Martins'
    };
    const rows = entries.filter((entry) => entry?.outcome === 'liquidated').map((entry) => {
      const row = document.createElement('tr');
      appendCell(row, formatDateTime(entry.completedAt));
      appendInvoiceNavigationCell(row, entry.invoiceId);
      appendCell(row, sourceNames[entry.source] || '—');
      appendCell(row, formatDate(entry.paidAt));
      appendCell(row, formatMoney(entry.amount));
      return row;
    });
    elements.liquidationLogRows.replaceChildren(...rows);
    elements.liquidationLogEmpty.hidden = rows.length > 0;
  };

  const renderLiquidationIssues = (issues) => {
    const rows = issues.map((issue) => {
      const row = document.createElement('tr');
      appendInvoiceNavigationCell(row, issue.invoiceId);
      appendCell(row, issue.bank === 'itau' ? 'Itaú' : issue.bank === 'bradesco' ? 'Bradesco' : '—');
      appendCell(row, `${issue.httpStatus ? `HTTP ${issue.httpStatus} · ` : ''}${issue.message || 'Falha sem detalhes salvos.'}`);
      appendCell(row, formatDateTime(issue.lastSeenAt));
      appendCell(row, issue.status === 'ignored' ? 'Ignorada na liquidação' : 'Pendente');
      const actionCell = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-quiet';
      button.textContent = issue.status === 'ignored' ? 'Reativar' : 'Ignorar erro';
      button.addEventListener('click', async () => {
        const ignoring = issue.status !== 'ignored';
        if (!window.confirm(ignoring
          ? `Retirar a fatura ${issue.invoiceId} da fila de liquidação? A cobrança dela continuará bloqueada até uma conferência segura.`
          : `Devolver a fatura ${issue.invoiceId} à fila de liquidação? A próxima conferência bancária tentará processá-la novamente.`
        )) return;
        button.disabled = true;
        try {
          const result = await requestJson(endpoint('bank-reconciliation-issues'), {
            method: 'POST',
            body: JSON.stringify({ invoiceId: issue.invoiceId, action: ignoring ? 'ignore' : 'resume' })
          });
          await loadLiquidationIssues();
          elements.liquidationIssuesMessage.textContent = result.message;
          elements.liquidationIssuesMessage.dataset.kind = 'success';
        } catch (error) {
          elements.liquidationIssuesMessage.textContent = error.message;
          elements.liquidationIssuesMessage.dataset.kind = 'error';
        } finally {
          button.disabled = false;
        }
      });
      actionCell.appendChild(button);
      row.appendChild(actionCell);
      return row;
    });
    elements.liquidationIssueRows.replaceChildren(...rows);
    elements.liquidationIssuesEmpty.hidden = rows.length > 0;
  };

  async function loadLiquidationIssues() {
    if (state.liquidationIssuesLoading) return;
    state.liquidationIssuesLoading = true;
    elements.refreshLiquidationIssues.disabled = true;
    elements.refreshLiquidationIssues.textContent = 'Atualizando…';
    try {
      const result = await requestJson(endpoint('bank-reconciliation-issues'));
      renderLiquidationIssues(Array.isArray(result.issues) ? result.issues : []);
      state.liquidationIssuesLoaded = true;
      elements.liquidationIssuesMessage.textContent = '';
      elements.liquidationIssuesMessage.dataset.kind = '';
    } catch (error) {
      elements.liquidationIssuesMessage.textContent = error.message;
      elements.liquidationIssuesMessage.dataset.kind = 'error';
    } finally {
      state.liquidationIssuesLoading = false;
      elements.refreshLiquidationIssues.disabled = state.loading;
      elements.refreshLiquidationIssues.textContent = 'Atualizar pendências';
    }
  }

  async function loadLiquidationLog() {
    if (state.liquidationLogLoading) return;
    state.liquidationLogLoading = true;
    elements.refreshLiquidationLog.disabled = true;
    elements.refreshLiquidationLog.textContent = 'Atualizando…';
    if (state.area === 'liquidation' && !state.loading) {
      elements.liquidationMessage.textContent = 'Carregando histórico de liquidações…';
      elements.liquidationMessage.dataset.kind = '';
    }
    try {
      const result = await requestJson(endpoint('liquidation-log'));
      renderLiquidationLog(Array.isArray(result.entries) ? result.entries : []);
      state.liquidationLogLoaded = true;
      if (state.area === 'liquidation' && !state.loading) {
        elements.liquidationMessage.textContent = '';
        elements.liquidationMessage.dataset.kind = '';
      }
    } catch (error) {
      elements.liquidationMessage.textContent = error.message;
      elements.liquidationMessage.dataset.kind = 'error';
    } finally {
      state.liquidationLogLoading = false;
      elements.refreshLiquidationLog.disabled = state.loading;
      elements.refreshLiquidationLog.textContent = 'Atualizar log';
    }
  }

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

  const clearJointBillingMemory = () => {
    state.jointPreview = null;
    state.jointInitialRetryCategory = null;
    state.jointSendRetry = false;
    state.jointExcludedIds.clear();
    elements.jointPreview.hidden = true;
    elements.jointRows.replaceChildren();
    elements.jointMatches.replaceChildren();
    elements.jointSearchForm.reset();
  };

  const setArea = (area) => {
    if (state.area === 'collection' && area !== 'collection'
      && state.collectionSection === 'jointBillingSection') clearJointBillingMemory();
    state.area = area;
    const collection = area === 'collection';
    elements.invoiceWorkspace.hidden = area !== 'invoices';
    elements.collectionWorkspace.hidden = !collection;
    elements.liquidationWorkspace.hidden = area !== 'liquidation';
    if (elements.inactiveWorkspace) elements.inactiveWorkspace.hidden = area !== 'inactive';
    elements.areaButtons.forEach((button) => {
      const active = button.dataset.billingArea === area;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    elements.backToTopButton.hidden = true;
    if (collection && !state.loaded) loadCollection();
    if (area === 'liquidation') {
      if (!state.liquidationLogLoaded) loadLiquidationLog();
      if (!state.liquidationIssuesLoaded) loadLiquidationIssues();
    }
  };

  const setCollectionSection = (sectionId, { focus = false } = {}) => {
    const button = elements.collectionSectionButtons.find(
      (item) => item.dataset.collectionSection === sectionId
    );
    if (!button) return;
    if (state.collectionSection === 'jointBillingSection' && sectionId !== 'jointBillingSection') {
      clearJointBillingMemory();
    }
    state.collectionSection = sectionId;
    elements.collectionSectionPanels.forEach((panel) => {
      panel.hidden = panel.id !== sectionId;
    });
    elements.collectionSectionButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    if (focus) button.focus();
  };

  elements.areaButtons.forEach((button) => {
    button.addEventListener('click', () => setArea(button.dataset.billingArea));
  });
  elements.focusLiquidationButton.addEventListener('click', async () => {
    if (state.loading) return;
    const continuing = Boolean(state.bulkCursor);
    if (!window.confirm(continuing
      ? 'Continuar a conferência dos boletos restantes? Apenas pagamentos confirmados serão baixados na Brudam.'
      : 'Buscar os boletos registrados no Itaú e Bradesco, conferir quais faturas seguem abertas e liquidar na Brudam somente os pagamentos confirmados?'
    )) return;
    if (!continuing) {
      state.bulkTotals = { checked: 0, settled: 0, alreadySettled: 0, pending: 0, errors: 0 };
      state.bulkIssues = [];
      elements.liquidationBatchIssues.replaceChildren();
      elements.liquidationBatchIssues.hidden = true;
    }
    setLoading(true);
    let hasMore = true;
    let rounds = 0;
    try {
      while (hasMore && rounds < 100) {
        const result = await requestJson(endpoint('bank-reconciliation-batch'), {
          method: 'POST',
          body: JSON.stringify({ afterInvoiceId: state.bulkCursor })
        });
        rounds += 1;
        state.bulkTotals.checked += Number(result.checked || 0);
        state.bulkTotals.settled += Number(result.settled || 0);
        state.bulkTotals.alreadySettled += Number(result.alreadySettled || 0);
        state.bulkTotals.pending += Number(result.pending || 0);
        state.bulkTotals.errors += (result.errors || []).length;
        state.bulkIssues.push(...(result.errors || []).slice(0, 20).map((issue) =>
          `Fatura ${issue.invoiceId || 'não identificada'} (${issue.bank || 'banco'}): ${issue.message}`));
        state.bulkIssues = state.bulkIssues.slice(0, 20);
        hasMore = result.hasMore === true;
        if (hasMore && (!/^\d{1,20}$/.test(String(result.nextCursor || '')) ||
            result.nextCursor === state.bulkCursor)) {
          throw new Error('A paginação da conferência não avançou. Nenhuma baixa adicional será tentada.');
        }
        state.bulkCursor = hasMore ? result.nextCursor : '';
        elements.liquidationMessage.textContent =
          `Conferindo boletos: ${state.bulkTotals.checked} verificado(s), ` +
          `${state.bulkTotals.settled} liquidado(s), ${state.bulkTotals.errors} falha(s)…`;
        elements.liquidationMessage.dataset.kind = '';
      }
      await loadLiquidationLog();
      await loadLiquidationIssues();
      const totals = state.bulkTotals;
      elements.liquidationMessage.textContent =
        `${hasMore ? 'Limite de lotes atingido; clique em Continuar liquidação. ' : 'Conferência concluída. '}` +
        `${totals.checked} boleto(s) verificado(s), ${totals.settled} fatura(s) liquidada(s), ` +
        `${totals.alreadySettled} já liquidada(s) na Brudam, ${totals.pending} sem pagamento confirmado ` +
        `e ${totals.errors} falha(s).`;
      elements.liquidationMessage.dataset.kind = totals.errors || hasMore ? 'warning' : 'success';
      elements.focusLiquidationButton.textContent = hasMore ? 'Continuar liquidação' : 'Liquidar faturas';
      elements.liquidationBatchIssues.replaceChildren(...state.bulkIssues.map((issue) => {
        const item = document.createElement('li');
        item.textContent = issue;
        return item;
      }));
      elements.liquidationBatchIssues.hidden = state.bulkIssues.length === 0;
    } catch (error) {
      elements.liquidationMessage.textContent =
        `${error.message} ${state.bulkTotals.checked} boleto(s) já conferido(s) nesta rodada.`;
      elements.liquidationMessage.dataset.kind = 'error';
      elements.focusLiquidationButton.textContent = state.bulkCursor
        ? 'Continuar liquidação' : 'Liquidar faturas';
    } finally {
      setLoading(false);
    }
  });
  elements.refreshLiquidationLog.addEventListener('click', () => loadLiquidationLog());
  elements.refreshLiquidationIssues.addEventListener('click', () => loadLiquidationIssues());

  elements.collectionSectionButtons.forEach((button, index) => {
    button.addEventListener('click', () => setCollectionSection(button.dataset.collectionSection));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const last = elements.collectionSectionButtons.length - 1;
      const targetIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + last + 1) % (last + 1);
      const target = elements.collectionSectionButtons[targetIndex];
      setCollectionSection(target.dataset.collectionSection, { focus: true });
    });
  });
  setCollectionSection(state.collectionSection);

  if (elements.paymentImportForm) {
    elements.paymentImportForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(elements.paymentImportForm);
      const file = data.get('file');
      if (!(file instanceof File) || !file.name) {
        setMessage('Selecione uma planilha XLSX.', 'error');
        return;
      }
      if (!/\.xlsx$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
        setMessage('Selecione um arquivo .xlsx de até 2 MB.', 'error');
        return;
      }
      setLoading(true);
      setMessage('Lendo a planilha e vinculando CT-es, DOCCOBs e faturas…');
      try {
        const result = await requestJson(endpoint('payment-import'), {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            fileBase64: await fileAsBase64(file)
          })
        });
        renderPaymentImport(result.import);
        setMessage(result.message || 'Planilha analisada.', 'success');
      } catch (error) {
        renderPaymentImport(null);
        setMessage(error.message, 'error');
      } finally {
        setLoading(false);
        renderPaymentImport(state.paymentImport);
      }
    });
    elements.approveAllPayments.addEventListener('click', () => approvePayments());
  }

  elements.categoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(elements.categoryForm);
    setLoading(true);
    try {
      const result = await requestJson(endpoint('categories'), {
        method: 'POST',
        body: JSON.stringify({
          cnpj: data.get('cnpj'),
          name: data.get('name'),
          billingMethod: data.get('billingMethod'),
          whiteMartins: data.get('whiteMartins') === 'on'
        })
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

  elements.categorySearchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const matches = matchingCategories(elements.categorySearchInput.value);
    if (!matches.length) {
      setMessage('Nenhuma empresa cadastrada corresponde à busca.', 'warning');
      return;
    }
    const card = [...elements.categoryList.querySelectorAll('.category-card')]
      .find((item) => item.dataset.cnpj === matches[0].cnpj);
    if (!card) return;
    card.open = true;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.querySelector('summary')?.focus();
    setMessage(matches.length > 1
      ? `${matches.length} empresas encontradas. Mostrando a primeira: ${matches[0].name}.`
      : `Empresa encontrada: ${matches[0].name}.`, 'success');
  });

  elements.jointSearchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const matches = matchingCategories(elements.jointSearchForm.elements.company.value);
    elements.jointMatches.replaceChildren();
    elements.jointPreview.hidden = true;
    state.jointPreview = null;
    state.jointInitialRetryCategory = null;
    state.jointSendRetry = false;
    state.jointExcludedIds.clear();
    if (!matches.length) {
      setMessage('Nenhuma empresa cadastrada corresponde à busca.', 'warning');
      return;
    }
    if (matches.length === 1) {
      loadJointCompany(matches[0]);
      return;
    }
    const prompt = document.createElement('p');
    prompt.textContent = `${matches.length} empresas encontradas. Escolha uma:`;
    elements.jointMatches.appendChild(prompt);
    for (const category of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-quiet';
      button.textContent = `${category.name} · ${formatCnpj(category.cnpj)}`;
      button.addEventListener('click', () => {
        elements.jointMatches.replaceChildren();
        loadJointCompany(category);
      });
      elements.jointMatches.appendChild(button);
    }
    setMessage('Selecione a empresa para consultar as faturas.', '');
  });

  elements.jointRefreshButton.addEventListener('click', async () => {
    await retryJointErrors(state.jointPreview);
  });

  elements.jointSendButton.addEventListener('click', async () => {
    if (state.jointInitialRetryCategory) {
      await loadJointCompany(state.jointInitialRetryCategory);
      return;
    }
    const preview = state.jointPreview;
    const selected = selectedJointInvoices();
    if (!selected.length || !preview?.recipients?.length
      || selected.some(blocksJointSend)) return;
    if (!window.confirm(`Enviar cobrança para ${preview.company.name}, com até ${selected.length} fatura(s) e anexos, a ${preview.recipients.length} destinatário(s)? Cada e-mail pronto será enviado automaticamente, com até 18 MB. Faturas cuja situação não puder ser confirmada na Brudam ficarão em espera para novas tentativas; nenhuma será enviada sem confirmação.`)) return;
    setLoading(true);
    setMessage('Preparando os anexos das faturas liberadas…');
    let sentBatches = 0;
    let sentInvoices = 0;
    let activeBatch = null;
    try {
      const outcome = await window.streamJointBillingInvoices(selected, {
        prepare: async (invoice) => {
          const bytes = await prepareJointInvoice(preview, invoice);
          setMessage(`Preparando faturas e enviando cada e-mail assim que completar 18 MB. `
            + `${sentBatches} e-mail(s) já aceito(s); preparando fatura ${invoice.id}…`);
          return bytes;
        },
        onPrepareError: async (invoice, error, { attempt, maxAttempts, willRetry }) => {
          if (!invoice.removed) {
            invoice.preparedToken = null;
            invoice.prepareError = error.message;
            if (error.retryStage === 'refresh' && !invoice.blocked) {
              invoice.unverified = true;
              invoice.blocked = true;
              invoice.proof = null;
              invoice.snapshot = null;
            }
          }
          renderJointPreview(preview);
          setMessage(`Fatura ${invoice.id} ${willRetry ? 'na fila de espera' : 'não enviada'} `
            + `(tentativa ${attempt}/${maxAttempts}): ${error.message} `
            + 'As demais continuam sendo processadas.', 'warning');
        },
        send: async (batch, number) => {
          activeBatch = batch;
          const invoiceIds = batch.map((invoice) => invoice.id);
          const invoiceProofs = batch.map(({ id, proof }) => ({ id, proof }));
          const invoicePackages = batch.map(({ id, preparedToken }) => ({ id, token: preparedToken }));
          setMessage(`Enviando e-mail ${number} com ${batch.length} fatura(s)…`);
          const result = await requestJson(endpoint('joint-billing'), {
            method: 'POST',
            body: JSON.stringify({ cnpj: preview.company.cnpj, invoiceIds, invoiceProofs,
              invoicePackages })
          });
          if (!['submitted', 'review'].includes(result.status)
            || !Array.isArray(result.invoiceIds)
            || result.invoiceIds.length !== invoiceIds.length
            || new Set(result.invoiceIds).size !== invoiceIds.length
            || result.invoiceIds.some((id) => !invoiceIds.includes(id))) {
            throw new Error('Resposta do envio incompleta. Confira os logs antes de tentar novamente.');
          }
          for (const invoice of batch) {
            invoice.preparedToken = null;
            invoice.jointSent = result.status !== 'review';
            invoice.sendReview = result.status === 'review';
            invoice.blocked = result.status === 'review';
            invoice.blockReason = result.status === 'review'
              ? 'O resultado deste e-mail exige conferência nos logs antes de qualquer reenvio.' : '';
            state.jointExcludedIds.add(invoice.id);
          }
          sentBatches += 1;
          sentInvoices += batch.length;
          renderJointPreview(preview);
          activeBatch = null;
          return result;
        }
      });
      if (outcome.review) {
        setMessage(`Um dos e-mails exige conferência nos logs. ${sentBatches - 1} anterior(es) `
          + 'aceito(s); as faturas ainda não enviadas permanecem nesta página. Não reenviar o grupo incerto.',
        'warning');
        return;
      }
      if (selectedJointInvoices().length) {
        setMessage(`${sentBatches} e-mail(s) aceito(s), ${sentInvoices} fatura(s) enviada(s) e `
          + `${outcome.errors} não enviada(s). Tente novamente apenas as pendentes ou ignore-as neste envio.`,
        'warning');
        return;
      }
      state.jointPreview = null;
      state.jointSendRetry = false;
      state.jointExcludedIds.clear();
      elements.jointPreview.hidden = true;
      elements.jointRows.replaceChildren();
      elements.jointSendButton.disabled = true;
      const message = `${sentBatches} e-mail(s) com ${sentInvoices} fatura(s) aceito(s) pelo servidor de e-mail.`
        + (outcome.errors ? ` ${outcome.errors} fatura(s) deixaram de estar aptas e não foram enviadas.` : '')
        + ' A entrega será confirmada nos logs.';
      setMessage(message, 'success');
      try { await loadLogs({ page: 1 }); } catch {
        setMessage(`${message} Os logs não puderam ser atualizados agora.`, 'warning');
      }
    } catch (error) {
      state.jointSendRetry = error.retryable === true;
      if (error.invoiceId && error.retryStage === 'prepare') {
        preview.invoices = preview.invoices.map((invoice) => invoice.id === error.invoiceId
          ? { ...invoice, preparedToken: null, prepareError: error.message }
          : invoice);
        renderJointPreview(preview);
      } else if (error.invoiceId && error.retryStage === 'refresh') {
        preview.invoices = preview.invoices.map((invoice) => invoice.id === error.invoiceId
          ? { ...invoice, unverified: true, blocked: true, proof: null, snapshot: null,
            preparedToken: null, prepareError: null,
            blockReason: error.message }
          : invoice);
        renderJointPreview(preview);
      }
      const uncertainDelivery = activeBatch && (!error.status || error.status >= 500
        || (error.status === 409 && !error.retryStage));
      if (uncertainDelivery) {
        for (const invoice of activeBatch) {
          invoice.sendReview = true;
          invoice.blocked = true;
          invoice.blockReason = 'Resultado deste e-mail incerto. Confira os logs antes de tentar novamente.';
          state.jointExcludedIds.add(invoice.id);
        }
        state.jointSendRetry = false;
        renderJointPreview(preview);
      }
      setMessage(`${sentBatches} e-mail(s) com ${sentInvoices} fatura(s) já aceito(s). ${error.message}`
        + (uncertainDelivery
          ? ' O grupo interrompido pode ter sido enviado; confira os logs antes de tentar novamente. Os demais grupos permanecem nesta página.'
          : ' Os demais grupos permanecem nesta página para nova tentativa.'), 'error');
    } finally {
      setLoading(false);
      updateJointSelection();
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
    const maxRounds = 25;
    const totals = {
      processed: 0,
      settledInvoices: 0,
      resolved: 0,
      sent: 0,
      retryable: 0,
      review: 0,
      errors: []
    };
    let after = '';
    let round = 0;
    let result = null;
    setLoading(true);
    try {
      do {
        round += 1;
        setMessage(
          round === 1
            ? 'Conferindo primeiro o status financeiro das pendências…'
            : `Conferindo o lote ${round} das pendências…`
        );
        result = await requestJson(endpoint('pending-refresh'), {
          method: 'POST',
          body: JSON.stringify({ after })
        });
        totals.processed += Number(result.processed || 0);
        totals.settledInvoices += Number(result.settledInvoices || 0);
        totals.resolved += Number(result.resolved || 0);
        totals.sent += Number(result.sent || 0);
        totals.retryable += Number(result.retryable || 0);
        totals.review += Number(result.review || 0);
        totals.errors.push(...(Array.isArray(result.errors) ? result.errors : []));
        after = String(result.nextAfter || '');
      } while (after && result.processed > 0 && round < maxRounds);
      await Promise.all([loadPending(), loadLogs()]);
      const incomplete = Boolean(after);
      setMessage(
        `Atualização concluída em ${round} lote(s): ${totals.processed} pendência(s) conferida(s), ${totals.settledInvoices} liquidada(s) removida(s), ${totals.resolved} problema(s) solucionado(s), ${totals.sent} e-mail(s) enviado(s), ${totals.retryable} envio(s) não aceito(s) para nova tentativa, ${totals.review} resultado(s) em conferência e ${totals.errors.length} outro(s) erro(s).${incomplete ? ' As demais pendências continuarão na próxima atualização.' : ''}`,
        totals.errors.length || totals.retryable || totals.review || incomplete ? 'warning' : 'success'
      );
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  if (elements.itauReconciliationPreviewForm) {
    const runButton = elements.itauReconciliationRunButton;
    const rearmButton = elements.itauReconciliationRearmButton;
    elements.itauReconciliationInvoiceId.addEventListener('input', () => {
      runButton.hidden = true;
      delete runButton.dataset.invoiceId;
      rearmButton.hidden = true;
      delete rearmButton.dataset.invoiceId;
    });
    elements.itauReconciliationPreviewForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const invoiceId = elements.itauReconciliationInvoiceId.value.trim();
      if (!/^\d{1,20}$/.test(invoiceId)) return;
      const output = elements.itauReconciliationPreviewResult;
      runButton.hidden = true;
      delete runButton.dataset.invoiceId;
      rearmButton.hidden = true;
      delete rearmButton.dataset.invoiceId;
      setLoading(true);
      output.textContent = `Conferindo o boleto e a fatura ${invoiceId}, sem liquidar…`;
      output.dataset.kind = '';
      try {
        const result = await requestJson(endpoint('bank-reconciliation-preview', { id: invoiceId }));
        const payment = result.paidAt
          ? ` Pagamento de ${formatMoney(result.paidAmount)} em ${formatDate(result.paidAt)}.`
          : '';
        const balance = Number.isFinite(Number(result.invoiceBalance))
          ? ` Saldo confirmado na Brudam: ${formatMoney(result.invoiceBalance)}.`
          : '';
        output.textContent = `Fatura ${result.invoiceId}: ${result.message}${payment}${balance}`;
        output.dataset.kind = result.status === 'eligible' || result.status === 'already_settled'
          ? 'success' : 'warning';
        if (result.status === 'eligible') {
          runButton.dataset.invoiceId = result.invoiceId;
          runButton.hidden = false;
        } else if (result.status === 'manual_review' && result.rearmAvailable) {
          rearmButton.dataset.invoiceId = result.invoiceId;
          rearmButton.hidden = false;
        }
      } catch (error) {
        output.textContent = error.message;
        output.dataset.kind = 'error';
      } finally {
        setLoading(false);
      }
    });

    rearmButton.addEventListener('click', async () => {
      const invoiceId = rearmButton.dataset.invoiceId;
      if (invoiceId !== '11838' || invoiceId !== elements.itauReconciliationInvoiceId.value.trim()) return;
      if (!window.confirm(
        'Liberar uma única nova tentativa manual de baixa da fatura 11838? Esta ação não envia a baixa. O agendador continuará bloqueado; confira novamente a prévia antes de liquidar.'
      )) return;
      const output = elements.itauReconciliationPreviewResult;
      rearmButton.hidden = true;
      setLoading(true);
      output.textContent = 'Reconfirmando o pagamento Itaú, o saldo na Brudam e o ID bancário antes da liberação…';
      output.dataset.kind = '';
      try {
        await requestJson(endpoint('itau-reconciliation-rearm'), {
          method: 'POST',
          body: JSON.stringify({ invoiceId })
        });
        output.textContent = 'Tentativa manual liberada. Atualizando a prévia sem liquidar…';
        output.dataset.kind = 'success';
        setLoading(false);
        elements.itauReconciliationPreviewForm.requestSubmit();
      } catch (error) {
        output.textContent = `Fatura ${invoiceId}: ${error.message}`;
        output.dataset.kind = 'error';
        setLoading(false);
      }
    });

    runButton.addEventListener('click', async () => {
      const invoiceId = runButton.dataset.invoiceId;
      if (!invoiceId || invoiceId !== elements.itauReconciliationInvoiceId.value.trim()) return;
      if (!window.confirm(
        `Confirma a baixa da fatura ${invoiceId} na Brudam? O servidor verificará novamente o pagamento e o saldo antes de gravar.`
      )) return;
      const output = elements.itauReconciliationPreviewResult;
      runButton.hidden = true;
      setLoading(true);
      output.textContent = `Reconfirmando e liquidando a fatura ${invoiceId}…`;
      output.dataset.kind = '';
      try {
        const result = await requestJson(endpoint('bank-reconciliation-invoice'), {
          method: 'POST',
          body: JSON.stringify({ invoiceId })
        });
        const messages = {
          liquidated: 'Baixa confirmada na Brudam.',
          already_settled: 'A fatura já estava liquidada na Brudam; nenhuma nova baixa foi enviada.',
          not_paid: 'O banco não confirmou pagamento integral; nenhuma baixa foi enviada.',
          in_progress: 'Outra execução está conferindo esta fatura.',
          manual_review: 'O resultado da tentativa exige conferência manual na Brudam. A baixa não será repetida automaticamente.'
        };
        output.textContent = `Fatura ${invoiceId}: ${messages[result.status] || 'Resultado não reconhecido; confira na Brudam.'}`;
        output.dataset.kind = result.status === 'liquidated' || result.status === 'already_settled'
          ? 'success' : 'warning';
        if (result.status === 'liquidated' || result.status === 'already_settled') {
          await loadLiquidationLog();
        }
      } catch (error) {
        output.textContent = `Fatura ${invoiceId}: ${error.message}`;
        output.dataset.kind = 'error';
      } finally {
        setLoading(false);
      }
    });
  }

  elements.runButton.addEventListener('click', async () => {
    const maxRounds = 25;
    const totals = {
      discovered: 0,
      processed: 0,
      sent: 0,
      retryable: 0,
      review: 0,
      pendingDoccob: 0,
      blocked: 0,
      settledInvoices: 0,
      deferredHistorical: 0,
      reconciled: 0,
      bankSettled: 0,
      errors: []
    };
    let result = null;
    let round = 0;
    setLoading(true);
    setMessage('Conferindo faturas, documentos e envios…');
    try {
      do {
        round += 1;
        setMessage(
          round === 1
            ? 'Conferindo faturas, documentos e envios…'
            : `Processando o lote ${round} da fila acumulada…`
        );
        result = await requestJson(endpoint('process', {
          ...(round > 1 ? { continuation: '1', runId: result?.runId } : {})
        }), { method: 'POST' });
        totals.discovered += Number(result.discovered || 0);
        totals.processed += Number(result.processed || 0);
        totals.sent += Number(result.sent || 0);
        totals.retryable += Number(result.retryable || 0);
        totals.review += Number(result.review || 0);
        totals.pendingDoccob += Number(result.pendingDoccob || 0);
        totals.blocked = Math.max(totals.blocked, Number(result.blocked || 0));
        totals.settledInvoices += Number(result.settledInvoices || 0);
        totals.deferredHistorical += Number(result.deferredHistorical || 0);
        totals.reconciled += Number(result.reconciled || 0);
        totals.bankSettled += Number(result.bankSettled || 0);
        totals.errors.push(...(Array.isArray(result.errors) ? result.errors : []));
      } while (
        result.stoppedByLimit
        && Number(result.remaining || 0) > 0
        && Number(result.processed || 0) > 0
        && round < maxRounds
      );
      await Promise.all([loadPending(), loadLogs()]);
      const incomplete = Boolean(result?.stoppedByLimit && Number(result.remaining || 0) > 0);
      setMessage(
        `Verificação concluída em ${round} lote(s): ${totals.reconciled} boleto(s) conferido(s), ${totals.bankSettled} fatura(s) liquidada(s) automaticamente, ${totals.processed} fatura(s) da fila examinada(s), ${totals.discovered} nova(s) fatura(s) registrada(s), ${totals.sent} e-mail(s) enviado(s), ${totals.retryable} envio(s) não aceito(s) para nova tentativa, ${totals.review} resultado(s) em conferência, ${totals.pendingDoccob} aguardando DOCCOB, ${totals.blocked} fatura(s) bloqueada(s) e ${totals.errors.length} outro(s) erro(s).${incomplete ? ` ${result.remaining || 0} fatura(s) continuarão na próxima verificação.` : ''}`,
        totals.errors.length || totals.retryable || totals.review || incomplete ? 'warning' : 'success'
      );
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  window.addEventListener('billing:navigate-logs', async (event) => {
    const invoiceId = String(event.detail?.invoiceId || '').replace(/\D/g, '');
    if (!invoiceId) return;
    elements.logsForm.elements.invoiceId.value = invoiceId;
    state.logFilters = { invoiceId };
    state.logPage = 1;
    const wasLoaded = state.loaded;
    setArea('collection');
    setCollectionSection('collectionLogsSection');
    if (!wasLoaded || state.loading) return;
    setLoading(true);
    try {
      await loadLogs({ filters: state.logFilters, page: 1 });
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });
})();
