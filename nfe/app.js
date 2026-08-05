(() => {
  const MAX_ITEMS = 10;
  const state = {
    keys: [],
    invalidTokens: [],
    processing: false,
    processingAvailable: false
  };

  const elements = Object.fromEntries([
    'loginView', 'appView', 'loginForm', 'user', 'password', 'togglePassword',
    'loginMessage', 'loginButton', 'logoutButton', 'minutaInput', 'keysPanel',
    'keysInput', 'batchCounter', 'validationSummary', 'processButton',
    'resultsCard', 'processingState', 'resultsTableWrap', 'resultsBody', 'resultTotals'
  ].map((id) => [id, document.getElementById(id)]));

  const api = async (action, options = {}) => {
    const response = await fetch(`/api/nfe?action=${encodeURIComponent(action)}`, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });
    const payload = await response.json().catch(() => ({
      status: 0,
      message: 'Resposta inválida do servidor.'
    }));
    if (!response.ok) {
      const error = new Error(payload.message || 'Não foi possível concluir a solicitação.');
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const setAuthenticated = (authenticated) => {
    elements.loginView.hidden = authenticated;
    elements.appView.hidden = !authenticated;
    if (authenticated) elements.minutaInput.focus();
    else elements.user.focus();
  };

  const checkSession = async () => {
    try {
      const payload = await api('session', { method: 'GET', headers: {} });
      state.processingAvailable = Boolean(payload.processingAvailable);
      setAuthenticated(Boolean(payload.authenticated));
    } catch {
      setAuthenticated(false);
    }
  };

  const setButtonBusy = (button, busy, busyLabel, idleLabel) => {
    button.disabled = busy;
    button.querySelector('span').textContent = busy ? busyLabel : idleLabel;
  };

  const onLogin = async (event) => {
    event.preventDefault();
    elements.loginMessage.textContent = '';
    setButtonBusy(elements.loginButton, true, 'Entrando…', 'Entrar');
    try {
      const payload = await api('login', {
        method: 'POST',
        body: JSON.stringify({
          user: elements.user.value.trim(),
          password: elements.password.value
        })
      });
      state.processingAvailable = Boolean(payload.processingAvailable);
      elements.loginForm.reset();
      setAuthenticated(true);
    } catch (error) {
      elements.loginMessage.textContent = error.message;
    } finally {
      setButtonBusy(elements.loginButton, false, 'Entrando…', 'Entrar');
    }
  };

  const onLogout = async () => {
    elements.logoutButton.disabled = true;
    try {
      await api('logout', { method: 'POST', body: '{}' });
    } finally {
      elements.logoutButton.disabled = false;
      setAuthenticated(false);
    }
  };

  const accessKeyCheckDigit = (first43Digits) => {
    let weight = 2;
    let sum = 0;
    for (let index = first43Digits.length - 1; index >= 0; index -= 1) {
      sum += Number(first43Digits[index]) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const result = 11 - (sum % 11);
    return result === 10 || result === 11 ? 0 : result;
  };

  const validKey = (key) =>
    /^\d{44}$/.test(key) && accessKeyCheckDigit(key.slice(0, 43)) === Number(key[43]);

  const parseKeys = () => {
    const raw = elements.keysInput.value;
    const candidates = raw
      .split(/[\r\n,;|]+/)
      .flatMap((value) => {
        const joined = value.replace(/\D/g, '');
        if (joined.length > 44 && joined.length % 44 === 0) {
          return joined.match(/.{44}/g) || [];
        }
        return joined ? [joined] : [];
      });
    state.keys = [...new Set(candidates.filter(validKey))];
    state.invalidTokens = candidates.filter((value) => !validKey(value));
    updateBatch();
  };

  const totalItems = () => state.keys.length;

  const updateBatch = () => {
    const total = totalItems();
    const minuta = elements.minutaInput.value.replace(/\D/g, '');
    const validMinuta = /^[1-9]\d{0,9}$/.test(minuta);
    elements.batchCounter.textContent = `${total} de ${MAX_ITEMS}`;
    elements.processButton.disabled = state.processing ||
      !state.processingAvailable ||
      !validMinuta ||
      total === 0 ||
      total > MAX_ITEMS ||
      state.invalidTokens.length > 0;
    elements.validationSummary.className = 'validation-summary';

    if (!state.processingAvailable) {
      elements.validationSummary.classList.add('is-warning');
      elements.validationSummary.innerHTML =
        '<span class="summary-icon">i</span><span>A vinculação aguarda a Brudam disponibilizar a atualização de uma minuta existente pela API.</span>';
    } else if (!validMinuta) {
      elements.validationSummary.classList.add('is-error');
      elements.validationSummary.innerHTML =
        '<span class="summary-icon">!</span><span>Informe o número da minuta existente na Brudam.</span>';
    } else if (state.invalidTokens.length) {
      elements.validationSummary.classList.add('is-error');
      elements.validationSummary.innerHTML =
        `<span class="summary-icon">!</span><span>${state.invalidTokens.length} chave(s) inválida(s). Cada chave deve ter 44 dígitos e dígito verificador correto.</span>`;
    } else if (total > MAX_ITEMS) {
      elements.validationSummary.classList.add('is-error');
      elements.validationSummary.innerHTML =
        `<span class="summary-icon">!</span><span>O lote excede o limite de ${MAX_ITEMS} NF-es.</span>`;
    } else if (total) {
      elements.validationSummary.classList.add('is-valid');
      elements.validationSummary.innerHTML =
        `<span class="summary-icon">✓</span><span>${total} NF-e(s) pronta(s) para a minuta ${minuta}.</span>`;
    } else {
      elements.validationSummary.innerHTML =
        '<span class="summary-icon">i</span><span>Cole as chaves de acesso para montar o lote.</span>';
    }
  };

  const shortKey = (key) => {
    if (!key) return 'Chave não informada';
    return `${key.slice(0, 6)}…${key.slice(-6)}`;
  };

  const renderResults = (payload) => {
    elements.resultTotals.innerHTML = [
      `<span class="result-total success">${payload.summary.successful} concluída(s)</span>`,
      payload.summary.failed
        ? `<span class="result-total error">${payload.summary.failed} com erro</span>`
        : ''
    ].join('');
    elements.resultsBody.replaceChildren();

    payload.results.forEach((result) => {
      const row = document.createElement('tr');
      const values = [
        result.number ? `NF ${result.number} · ${shortKey(result.key)}` : shortKey(result.key),
        result.source === 'sefaz' ? 'SEFAZ' : 'Consulta interna',
        result.status === 'success'
          ? (result.alreadyProcessed ? 'Já processada' : 'Concluída')
          : 'Erro',
        result.minuta || '—',
        result.message || '—'
      ];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        if (index === 0) cell.className = 'key-cell';
        if (index === 2) {
          const badge = document.createElement('span');
          badge.className = `row-status ${result.status}`;
          badge.textContent = value;
          cell.append(badge);
        } else {
          cell.textContent = value;
          if (index === 4) cell.className = 'row-message';
        }
        row.append(cell);
      });
      elements.resultsBody.append(row);
    });
  };

  const onProcess = async () => {
    state.processing = true;
    updateBatch();
    elements.resultsCard.hidden = false;
    elements.processingState.hidden = false;
    elements.resultsTableWrap.hidden = true;
    elements.resultTotals.replaceChildren();
    elements.resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const payload = await api('process', {
        method: 'POST',
        body: JSON.stringify({
          minuta: elements.minutaInput.value.trim(),
          keys: state.keys
        })
      });
      renderResults(payload);
      elements.resultsTableWrap.hidden = false;
    } catch (error) {
      if (error.status === 401) {
        setAuthenticated(false);
        elements.loginMessage.textContent = error.message;
      } else {
        elements.resultTotals.innerHTML =
          `<span class="result-total error">${error.message}</span>`;
      }
    } finally {
      state.processing = false;
      elements.processingState.hidden = true;
      updateBatch();
    }
  };

  elements.loginForm.addEventListener('submit', onLogin);
  elements.logoutButton.addEventListener('click', onLogout);
  elements.togglePassword.addEventListener('click', () => {
    const show = elements.password.type === 'password';
    elements.password.type = show ? 'text' : 'password';
    elements.togglePassword.textContent = show ? 'Ocultar' : 'Mostrar';
    elements.togglePassword.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  });
  elements.minutaInput.addEventListener('input', updateBatch);
  elements.keysInput.addEventListener('input', parseKeys);
  elements.processButton.addEventListener('click', onProcess);

  checkSession();
})();
