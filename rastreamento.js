(() => {
  'use strict';

  const TRACKING_API_URL = '/api/rastreamento';
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
    const documentType = selectedDocumentType();
    const requiresTaxpayer = ['nf', 'cte'].includes(documentType);
    const documentPlaceholders = {
      nf: 'Número da nota fiscal',
      cte: 'Número do CT-e',
      minuta: 'Número da minuta'
    };

    taxpayerField?.classList.toggle('is-hidden', !requiresTaxpayer);
    taxpayerField?.setAttribute('aria-hidden', String(!requiresTaxpayer));

    if (documentInput) {
      documentInput.placeholder = documentPlaceholders[documentType] ?? 'Número do documento';
    }

    if (taxpayerInput) {
      taxpayerInput.required = requiresTaxpayer;
      taxpayerInput.disabled = !requiresTaxpayer;
      if (!requiresTaxpayer) taxpayerInput.value = '';
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

  const queryTracking = async (type, taxpayer, number) => {
    const response = await fetchWithTimeout(TRACKING_API_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type,
        taxpayer,
        number
      }),
      credentials: 'same-origin'
    });
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
    return {
      type,
      document: number,
      deliveryForecast: deliveryDate,
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

  const formatDateOnly = (value) => {
    if (!value) return 'Data não informada';
    const normalizedValue = String(value).trim();
    const isoMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      const [, year, month, day] = isoMatch;
      return `${day}/${month}/${year}`;
    }

    const brazilianMatch = normalizedValue.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (brazilianMatch) {
      const [, day, month, year] = brazilianMatch;
      return `${day}/${month}/${year}`;
    }

    return normalizedValue.replace(/\s+(?:às\s+)?\d{1,2}:\d{2}(?::\d{2})?.*$/i, '');
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
        ? isFinalized ? formatDateTime(relevantDate) : formatDateOnly(relevantDate)
        : 'Não informada';
    }
    if (documentSummary) {
      const documentLine = `${TYPE_LABELS[tracking.type] ?? 'Documento'}: ${tracking.document}`;
      const summaryContent = [documentLine];
      if (tracking.volumeCount) {
        summaryContent.push(document.createElement('br'), `№ Volumes: ${tracking.volumeCount}`);
      }
      documentSummary.replaceChildren(...summaryContent);
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
