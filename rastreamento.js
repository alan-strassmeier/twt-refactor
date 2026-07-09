(() => {
  'use strict';

  const BRUDAM_API_URL = 'https://twt.brudam.com.br/api/v1';
  const REQUEST_TIMEOUT = 20000;
  const TYPE_LABELS = {
    nf: 'Nota Fiscal',
    cte: 'CT-e',
    minuta: 'Minuta'
  };
  const MINUTE_STATUS_LABELS = {
    0: 'EMISSÃO',
    1: 'EMISSÃO REALIZADA',
    2: 'CARGA MANIFESTADA',
    3: 'ENTREGA EM TRÂNSITO',
    4: 'PENDÊNCIA',
    5: 'DEPÓSITO',
    6: 'FINALIZADA',
    7: 'CONFERÊNCIA',
    10: 'GERAL',
    11: 'POSITIVA',
    12: 'PRÉ-EMISSÃO',
    13: 'CANCELADA',
    14: 'COMPLEMENTO'
  };

  const form = document.getElementById('trackingForm');
  const submitButton = form?.querySelector('.buscar_rastreamento');
  const taxpayerField = document.getElementById('trackingTaxpayerField');
  const taxpayerInput = document.getElementById('your-cnpj');
  const documentInput = document.getElementById('your-document');
  const preloader = document.getElementById('preloader');
  const errorContainer = document.querySelector('.erro_rastreamento');
  const eventsContainer = document.querySelector('.ocorrencias');
  const deliveryDateTitle = document.getElementById('deliveryDateTitle');
  const lastUpdate = document.getElementById('prev_entrega');
  const documentSummary = document.getElementById('vol_peso');
  const currentStatus = document.getElementById('trecho');

  let credentials = null;
  let accessToken = '';
  let tokenExpiresAt = 0;
  let errorTimer;

  const selectedDocumentType = () => form
    ?.querySelector('input[name="document-type"]:checked')
    ?.value ?? 'nf';

  const createElement = (tagName, options = {}) => {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text) element.textContent = options.text;
    Object.entries(options.attributes ?? {}).forEach(([name, value]) => {
      element.setAttribute(name, value);
    });
    return element;
  };

  const setLoading = (loading) => {
    preloader?.classList.toggle('is-visible', loading);
    preloader?.setAttribute('aria-hidden', String(!loading));
    form?.setAttribute('aria-busy', String(loading));
    if (submitButton) {
      submitButton.disabled = loading;
      submitButton.setAttribute('aria-busy', String(loading));
    }
  };

  const clearResults = () => {
    eventsContainer?.replaceChildren();
    if (deliveryDateTitle) deliveryDateTitle.textContent = 'Previsão de Entrega';
    if (lastUpdate) lastUpdate.textContent = '';
    if (documentSummary) documentSummary.textContent = '';
    if (currentStatus) currentStatus.textContent = '';
  };

  const showError = (message) => {
    window.clearTimeout(errorTimer);
    errorContainer?.replaceChildren();

    const paragraph = createElement('p', { text: message });
    errorContainer?.appendChild(paragraph);
    errorTimer = window.setTimeout(() => errorContainer?.replaceChildren(), 5000);
  };

  const updateRequiredFields = () => {
    const requiresTaxpayer = ['nf', 'cte'].includes(selectedDocumentType());
    taxpayerField?.classList.toggle('is-hidden', !requiresTaxpayer);
    taxpayerField?.setAttribute('aria-hidden', String(!requiresTaxpayer));

    if (taxpayerInput) {
      taxpayerInput.required = requiresTaxpayer;
      taxpayerInput.disabled = !requiresTaxpayer;
      if (!requiresTaxpayer) taxpayerInput.value = '';
    }
  };

  const requestCredentials = () => new Promise((resolve, reject) => {
    const dialog = createElement('dialog', {
      className: 'api-credentials-dialog',
      attributes: {
        'aria-labelledby': 'apiCredentialsTitle',
        'aria-describedby': 'apiCredentialsWarning'
      }
    });
    const credentialForm = createElement('form', { attributes: { method: 'dialog' } });
    const title = createElement('h2', {
      text: 'Acesso temporário à API',
      attributes: { id: 'apiCredentialsTitle' }
    });
    const warning = createElement('p', {
      className: 'api-credentials-warning',
      text: 'Modo exclusivo para testes. As credenciais ficarão na memória desta aba até a página ser recarregada.',
      attributes: { id: 'apiCredentialsWarning' }
    });
    const userLabel = createElement('label', { text: 'Usuário Brudam' });
    const userInput = createElement('input', {
      attributes: {
        type: 'text',
        minlength: '32',
        maxlength: '32',
        pattern: '[A-Fa-f0-9]{32}',
        required: '',
        autocomplete: 'off',
        spellcheck: 'false'
      }
    });
    const passwordLabel = createElement('label', { text: 'Senha Brudam' });
    const passwordInput = createElement('input', {
      attributes: {
        type: 'password',
        minlength: '64',
        maxlength: '64',
        pattern: '[A-Fa-f0-9]{64}',
        required: '',
        autocomplete: 'off'
      }
    });
    const actions = createElement('div', { className: 'api-credentials-actions' });
    const cancelButton = createElement('button', {
      className: 'api-credentials-cancel',
      text: 'Cancelar',
      attributes: { type: 'button' }
    });
    const confirmButton = createElement('button', {
      className: 'form-button',
      text: 'Usar neste teste',
      attributes: { type: 'submit' }
    });

    userLabel.appendChild(userInput);
    passwordLabel.appendChild(passwordInput);
    actions.append(cancelButton, confirmButton);
    credentialForm.append(title, warning, userLabel, passwordLabel, actions);
    dialog.appendChild(credentialForm);
    document.body.appendChild(dialog);

    const cancel = () => {
      dialog.close();
      dialog.remove();
      reject(new Error('Configuração do acesso cancelada.'));
    };

    cancelButton.addEventListener('click', cancel);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      cancel();
    }, { once: true });
    credentialForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!credentialForm.reportValidity()) return;

      const temporaryCredentials = {
        user: userInput.value.trim(),
        password: passwordInput.value
      };
      passwordInput.value = '';
      dialog.close();
      dialog.remove();
      resolve(temporaryCredentials);
    }, { once: true });

    dialog.showModal();
    userInput.focus();
  });

  const tokenExpiration = (token) => {
    try {
      const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - encodedPayload.length % 4) % 4);
      const payload = JSON.parse(window.atob(encodedPayload + padding));
      return Number(payload.exp) * 1000;
    } catch {
      return Date.now() + 240000;
    }
  };

  const fetchWithTimeout = async (url, options) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const readJson = async (response) => {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error('A API retornou uma resposta inválida.');
    }
    return response.json();
  };

  const authenticate = async (forceRefresh = false) => {
    if (!forceRefresh && accessToken && Date.now() < tokenExpiresAt - 30000) {
      return accessToken;
    }
    if (!credentials) credentials = await requestCredentials();

    const response = await fetchWithTimeout(`${BRUDAM_API_URL}/acesso/auth/login`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usuario: credentials.user,
        senha: credentials.password
      }),
      credentials: 'omit'
    });
    const payload = await readJson(response);
    const newToken = payload?.data?.access_key;

    if (!response.ok || typeof newToken !== 'string' || !newToken) {
      credentials = null;
      throw new Error(payload.message || 'Acesso Brudam inválido.');
    }

    accessToken = newToken;
    tokenExpiresAt = tokenExpiration(newToken);
    return accessToken;
  };

  const trackingUrl = (type, taxpayer, number) => {
    const routes = {
      nf: ['/tracking/ocorrencias/cnpj/nf', { documento: taxpayer, numero: number }],
      cte: ['/tracking/ocorrencias/cnpj/cte', { documento: taxpayer, numero: number }],
      minuta: ['/tracking/ocorrencias/minuta', { codigo: number }]
    };
    const [path, query] = routes[type];
    return `${BRUDAM_API_URL}${path}?${new URLSearchParams(query)}`;
  };

  const queryTracking = async (type, taxpayer, number, retry = true) => {
    const token = await authenticate();
    const response = await fetchWithTimeout(trackingUrl(type, taxpayer, number), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      credentials: 'omit'
    });

    if (response.status === 401 && retry) {
      accessToken = '';
      tokenExpiresAt = 0;
      await authenticate(true);
      return queryTracking(type, taxpayer, number, false);
    }

    const payload = await readJson(response);
    if (!response.ok || payload.status !== 1) {
      throw new Error(payload.message || 'Nenhuma ocorrência encontrada.');
    }
    return payload;
  };

  const firstAvailableValue = (sources, keys) => {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          return String(value).trim();
        }
      }
    }
    return '';
  };

  const normalizeTracking = (payload, type, number) => {
    const documents = Array.isArray(payload.data) ? payload.data : [];
    const rawEvents = documents
      .flatMap((documentData) => Array.isArray(documentData?.dados) ? documentData.dados : [])
      .sort((first, second) => String(second?.data ?? '').localeCompare(String(first?.data ?? '')));
    const nestedMinuteData = documents
      .map((documentData) => documentData?.minuta)
      .filter((minuteData) => minuteData && typeof minuteData === 'object');
    const transportedData = documents
      .map((documentData) => documentData?.transportado)
      .filter((data) => data && typeof data === 'object');
    const metadataSources = [...rawEvents, ...nestedMinuteData, ...transportedData, ...documents, payload];

    const events = rawEvents
      .map((eventData) => ({
        code: String(eventData.status ?? ''),
        date: String(eventData.data ?? ''),
        description: String(eventData.descricao ?? eventData.message ?? 'Atualização de rastreamento'),
        note: String(eventData.obs ?? '')
      }));

    const completedDeliveryEvent = events.find((eventData) => eventData.description
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .includes('ENTREGA REALIZADA'));

    if (events.length === 0) throw new Error('Nenhuma ocorrência encontrada.');
    const deliveryDate = firstAvailableValue(metadataSources, [
      'previsao_entrega', 'previsaoEntrega', 'data_previsao_entrega', 'previsao'
    ]);
    const deliveryTime = firstAvailableValue(metadataSources, [
      'hora_previsao_entrega', 'previsao_entrega_hora', 'horaPrevisaoEntrega',
      'hora_previsao', 'previsao_hora', 'hora_entrega_prevista'
    ]);
    const deliveryForecast = deliveryDate && deliveryTime && !/\b\d{1,2}:\d{2}\b/.test(deliveryDate)
      ? `${deliveryDate} ${deliveryTime}`
      : deliveryDate;

    return {
      type,
      document: number,
      deliveryForecast,
      minuteStatus: firstAvailableValue(metadataSources, [
        'status_minuta', 'statusMinuta', 'situacao_minuta', 'situacaoMinuta'
      ]),
      volumeCount: firstAvailableValue(metadataSources, [
        'volumes_transportado', 'volumes_transportados', 'volumesTransportado',
        'volumesTransportados', 'total_volumes', 'volumes', 'qtd_volumes', 'quantidade_volumes',
        'numero_volumes', 'num_volumes', 'volume'
      ]),
      completedDeliveryAt: completedDeliveryEvent?.date ?? '',
      events
    };
  };

  const formatDateTime = (value) => {
    if (!value) return 'Data não informada';
    const normalizedValue = String(value).trim();
    const isoMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?/);
    if (isoMatch) {
      const [, year, month, day, hour, minute] = isoMatch;
      return hour ? `${day}/${month}/${year} às ${hour}:${minute}` : `${day}/${month}/${year}`;
    }

    const brazilianMatch = normalizedValue.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(?:às\s+)?(\d{1,2}):(\d{2}))?/i);
    if (brazilianMatch) {
      const [, day, month, year, hour, minute] = brazilianMatch;
      return hour ? `${day}/${month}/${year} às ${hour.padStart(2, '0')}:${minute}` : `${day}/${month}/${year}`;
    }

    return normalizedValue;
  };

  const formatMinuteStatus = (status) => {
    const normalizedStatus = String(status ?? '').trim();
    if (!normalizedStatus) return '';
    if (MINUTE_STATUS_LABELS[normalizedStatus]) return MINUTE_STATUS_LABELS[normalizedStatus];
    return /^\d+$/.test(normalizedStatus) ? `Status da minuta: ${normalizedStatus}` : normalizedStatus;
  };

  const createEventRow = (eventData) => {
    const row = createElement('div', {
      className: 'text-input tracking-event',
      attributes: { role: 'listitem' }
    });
    const content = createElement('span');
    const heading = createElement('strong', {
      text: `${formatDateTime(eventData.date)} — ${eventData.description}`
    });
    content.appendChild(heading);
    if (eventData.note) content.append(` — ${eventData.note}`);
    row.appendChild(content);
    return row;
  };

  const renderTracking = (tracking) => {
    const normalizedStatus = String(tracking.minuteStatus ?? '').trim().toUpperCase();
    const isFinalized = normalizedStatus === '6' || normalizedStatus === 'FINALIZADA';

    if (deliveryDateTitle) {
      deliveryDateTitle.textContent = isFinalized ? 'Entrega Realizada' : 'Previsão de Entrega';
    }
    if (lastUpdate) {
      const relevantDate = isFinalized ? tracking.completedDeliveryAt : tracking.deliveryForecast;
      lastUpdate.textContent = relevantDate
        ? formatDateTime(relevantDate)
        : 'Não informada';
    }
    if (documentSummary) {
      const documentLine = `${TYPE_LABELS[tracking.type] ?? 'Documento'}: ${tracking.document}`;
      const volumesLine = `№ Volumes: ${tracking.volumeCount || 'Não informado'}`;
      documentSummary.replaceChildren(documentLine, document.createElement('br'), volumesLine);
    }
    if (currentStatus) {
      currentStatus.textContent = formatMinuteStatus(tracking.minuteStatus) || 'Não informado';
    }

    const fragment = document.createDocumentFragment();
    tracking.events.forEach((eventData) => fragment.appendChild(createEventRow(eventData)));
    eventsContainer?.replaceChildren(fragment);
    window.showPrice_rastreamento?.(submitButton);
  };

  const searchTracking = async (event) => {
    event.preventDefault();
    if (!form?.reportValidity()) return;

    clearResults();
    setLoading(true);

    try {
      const type = selectedDocumentType();
      const taxpayer = taxpayerInput?.value.replace(/\D/g, '') ?? '';
      const number = documentInput?.value.trim() ?? '';
      const payload = await queryTracking(type, taxpayer, number);
      renderTracking(normalizeTracking(payload, type, number));
    } catch (error) {
      const message = error.name === 'AbortError'
        ? 'A consulta demorou demais. Tente novamente.'
        : error.message;
      showError(message || 'Rastreamento temporariamente indisponível.');
    } finally {
      setLoading(false);
    }
  };

  form?.querySelectorAll('input[name="document-type"]').forEach((input) => {
    input.addEventListener('change', updateRequiredFields);
  });
  form?.addEventListener('submit', searchTracking);
  updateRequiredFields();
})();
