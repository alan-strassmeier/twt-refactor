'use strict';

const { readFile } = require('node:fs/promises');
const { normalizeDomain } = require('./routing');

const loadContacts = async (filename) => {
  const parsed = JSON.parse(await readFile(filename, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('O cadastro de contatos precisa ser um objeto JSON.');
  }
  const domains = {};
  for (const [rawDomain, entry] of Object.entries(parsed.domains || {})) {
    const domain = normalizeDomain(rawDomain);
    if (!domain) throw new Error(`Domínio inválido no cadastro: ${rawDomain}`);
    if (domains[domain]) throw new Error(`Domínio duplicado no cadastro: ${domain}`);
    domains[domain] = entry;
  }
  return { domains };
};

module.exports = { loadContacts };
