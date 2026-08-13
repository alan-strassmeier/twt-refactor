'use strict';

const DEFAULT_SETTINGS = {
  apiUrl: 'https://www.twt.com.br',
  apiToken: '',
  contacts: [],
  selectedContact: ''
};

const elements = {
  collectionId: document.getElementById('collection-id'),
  query: document.getElementById('query'),
  contact: document.getElementById('contact'),
  message: document.getElementById('message'),
  openWhatsApp: document.getElementById('open-whatsapp'),
  status: document.getElementById('status'),
  contactForm: document.getElementById('contact-form'),
  contactName: document.getElementById('contact-name'),
  contactPhone: document.getElementById('contact-phone'),
  contactList: document.getElementById('contact-list'),
  settingsForm: document.getElementById('settings-form'),
  apiUrl: document.getElementById('api-url'),
  apiToken: document.getElementById('api-token')
};

let settings = { ...DEFAULT_SETTINGS };

const storageGet = (defaults) => new Promise((resolve) => {
  chrome.storage.local.get(defaults, resolve);
});

const storageSet = (values) => new Promise((resolve) => {
  chrome.storage.local.set(values, resolve);
});

const setStatus = (message, error = false) => {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
};

const normalizePhone = (value) => {
  const digits = String(value).replace(/\D/g, '');
  if ([10, 11].includes(digits.length)) return `55${digits}`;
  return /^\d{12,15}$/.test(digits) ? digits : '';
};

const normalizedApiUrl = (value) => {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Endereço inválido.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Use HTTPS fora do ambiente local.');
  }
  return url.origin;
};

const updateSendState = () => {
  elements.openWhatsApp.disabled = !(
    elements.contact.value && elements.message.value.trim()
  );
};

const renderContacts = () => {
  const previous = settings.selectedContact;
  elements.contact.replaceChildren();

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = settings.contacts.length
    ? 'Selecione um contato'
    : 'Cadastre um contato abaixo';
  elements.contact.appendChild(placeholder);

  const listFragment = document.createDocumentFragment();
  settings.contacts.forEach((contact) => {
    const option = document.createElement('option');
    option.value = contact.phone;
    option.textContent = `${contact.name} — ${contact.phone}`;
    elements.contact.appendChild(option);

    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${contact.name} — ${contact.phone}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-contact';
    remove.dataset.phone = contact.phone;
    remove.setAttribute('aria-label', `Remover ${contact.name}`);
    remove.textContent = 'Remover';
    item.append(label, remove);
    listFragment.appendChild(item);
  });
  elements.contactList.replaceChildren(listFragment);

  if (settings.contacts.some((contact) => contact.phone === previous)) {
    elements.contact.value = previous;
  }
  updateSendState();
};

const saveContacts = async () => {
  await storageSet({
    contacts: settings.contacts,
    selectedContact: settings.selectedContact
  });
};

const queryCollection = async () => {
  const id = elements.collectionId.value.trim();
  if (!/^\d{1,10}$/.test(id)) {
    setStatus('Informe um número de coleta válido.', true);
    elements.collectionId.focus();
    return;
  }
  if (!settings.apiToken || settings.apiToken.length < 32) {
    setStatus('Salve o token interno em Configuração.', true);
    return;
  }

  elements.query.disabled = true;
  setStatus('Consultando a Brudam…');
  try {
    const url = `${settings.apiUrl}/api/coleta?${new URLSearchParams({ id })}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${settings.apiToken}` }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload.status) !== 1) {
      throw new Error(payload.message || 'Não foi possível consultar a coleta.');
    }
    elements.message.value = payload.data.message;
    setStatus(`Coleta ${id} carregada. Revise a mensagem antes de enviar.`);
  } catch (error) {
    setStatus(error.message || 'Consulta temporariamente indisponível.', true);
  } finally {
    elements.query.disabled = false;
    updateSendState();
  }
};

elements.query.addEventListener('click', queryCollection);
elements.collectionId.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') queryCollection();
});
elements.message.addEventListener('input', updateSendState);
elements.contact.addEventListener('change', async () => {
  settings.selectedContact = elements.contact.value;
  await storageSet({ selectedContact: settings.selectedContact });
  updateSendState();
});

elements.openWhatsApp.addEventListener('click', () => {
  const phone = elements.contact.value;
  const message = elements.message.value.trim();
  if (!phone || !message) return;
  chrome.tabs.create({
    url: `https://wa.me/${phone}?${new URLSearchParams({ text: message })}`
  });
});

elements.contactForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = elements.contactName.value.trim();
  const phone = normalizePhone(elements.contactPhone.value);
  if (!name || !phone) {
    setStatus('Informe nome e WhatsApp válido, com DDD.', true);
    return;
  }
  if (settings.contacts.some((contact) => contact.phone === phone)) {
    setStatus('Esse WhatsApp já está cadastrado.', true);
    return;
  }
  settings.contacts.push({ name, phone });
  settings.contacts.sort((first, second) => first.name.localeCompare(second.name, 'pt-BR'));
  settings.selectedContact = phone;
  await saveContacts();
  elements.contactForm.reset();
  renderContacts();
  setStatus('Contato adicionado.');
});

elements.contactList.addEventListener('click', async (event) => {
  const button = event.target.closest('.remove-contact');
  if (!button) return;
  settings.contacts = settings.contacts.filter((contact) => contact.phone !== button.dataset.phone);
  if (settings.selectedContact === button.dataset.phone) settings.selectedContact = '';
  await saveContacts();
  renderContacts();
  setStatus('Contato removido.');
});

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const apiUrl = normalizedApiUrl(elements.apiUrl.value);
    const apiToken = elements.apiToken.value.trim();
    if (apiToken.length < 32) throw new Error('O token deve ter pelo menos 32 caracteres.');
    settings = { ...settings, apiUrl, apiToken };
    await storageSet({ apiUrl, apiToken });
    elements.apiUrl.value = apiUrl;
    setStatus('Configuração salva.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

const init = async () => {
  settings = await storageGet(DEFAULT_SETTINGS);
  elements.apiUrl.value = settings.apiUrl;
  elements.apiToken.value = settings.apiToken;
  renderContacts();
};

init();
