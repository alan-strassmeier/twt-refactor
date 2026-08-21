'use strict';

const { domainToASCII } = require('node:url');

const normalizeDomain = (value) => domainToASCII(String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^@/, '')
  .replace(/\.$/, ''));

const domainFromAddress = (address) => {
  const normalized = String(address || '').trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  return separator > 0 ? normalizeDomain(normalized.slice(separator + 1)) : '';
};

const addressesFor = (field) => Array.isArray(field?.value)
  ? field.value.map((entry) => entry.address).filter(Boolean)
  : [];

const externalDomains = (message, internalDomains) => {
  const internal = new Set(internalDomains.map(normalizeDomain).filter(Boolean));
  const addresses = [...addressesFor(message.to), ...addressesFor(message.cc)];
  return [...new Set(addresses
    .map(domainFromAddress)
    .filter((domain) => domain && !internal.has(domain)))]
    .sort();
};

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{12,15}$/.test(digits)) {
    throw new Error(`WhatsApp inválido no cadastro: ${value}`);
  }
  return digits;
};

const resolveRecipients = (domains, registry) => {
  const recipients = [];
  const missingDomains = [];

  for (const domain of domains) {
    const entry = registry.domains?.[domain];
    const contacts = Array.isArray(entry?.contacts)
      ? entry.contacts.filter((contact) => contact.enabled !== false)
      : [];
    if (!contacts.length) {
      missingDomains.push(domain);
      continue;
    }
    for (const contact of contacts) {
      recipients.push({
        domain,
        company: String(entry.company || domain).trim(),
        name: String(contact.name || '').trim(),
        phone: normalizePhone(contact.phone)
      });
    }
  }

  const unique = new Map();
  for (const recipient of recipients) {
    const current = unique.get(recipient.phone);
    if (current) {
      current.domains = [...new Set([...current.domains, recipient.domain])];
    } else {
      unique.set(recipient.phone, { ...recipient, domains: [recipient.domain] });
    }
  }

  return { recipients: [...unique.values()], missingDomains };
};

module.exports = {
  addressesFor,
  domainFromAddress,
  externalDomains,
  normalizeDomain,
  normalizePhone,
  resolveRecipients
};
