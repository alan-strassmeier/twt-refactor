const store = require('./cobranca-store');
const {
  authenticatedGet,
  authenticatedPatch,
  companyLookupPath,
  companyRecordsFromPayload
} = require('./brudam');

const digits = (value) => String(value || '').replace(/\D/g, '');
const emailKey = (value) => String(value || '').trim().toLocaleLowerCase('pt-BR');

const upstreamError = (message, statusCode = 502) => Object.assign(new Error(message), {
  statusCode,
  expose: true
});

const field = (value, names) => {
  if (!value || typeof value !== 'object') return '';
  for (const name of names) {
    if (value[name] !== undefined && value[name] !== null && value[name] !== '') return value[name];
    const actual = Object.keys(value).find((key) => key.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'));
    if (actual && value[actual] !== '') return value[actual];
  }
  return '';
};

const companyCnpj = (company) => digits(field(company, ['cnpj', 'cpf_cnpj', 'documento']));

const companyFromPayload = (payload, cnpj) => {
  const expected = digits(cnpj);
  return companyRecordsFromPayload(payload).find((company) => companyCnpj(company) === expected) || null;
};

const companyName = (company) => String(
  field(company, ['fantasia', 'nome_fantasia', 'razao', 'razao_social', 'nome']) || ''
).trim();

const groupContacts = (company) => {
  const group = field(company, ['xGrupo']);
  return Array.isArray(group) ? group : [];
};

const contactsFromCompany = (company) => groupContacts(company).map((contact) => ({
  firstName: String(field(contact, ['xNome', 'nome']) || '').trim(),
  lastName: '',
  email: emailKey(field(contact, ['email'])),
  enabled: false
})).filter((contact) => contact.email);

const fetchCompany = async (cnpj, get = authenticatedGet) => {
  const normalizedCnpj = digits(cnpj);
  if (normalizedCnpj.length !== 14) {
    throw Object.assign(new Error('Informe um CNPJ com 14 números.'), { statusCode: 422 });
  }
  const result = await get(companyLookupPath({ cnpj: normalizedCnpj }));
  if (!result?.response?.ok) {
    throw upstreamError(
      result?.payload?.message || `A Brudam recusou a consulta da empresa (HTTP ${result?.response?.status || 502}).`
    );
  }
  const company = companyFromPayload(result.payload, normalizedCnpj);
  if (!company) {
    throw Object.assign(new Error('Empresa não encontrada na Brudam para o CNPJ informado.'), {
      statusCode: 404
    });
  }
  return company;
};

const syncCompanyContacts = async (cnpj, dependencies = {}) => {
  const storage = dependencies.store || store;
  const company = dependencies.company || await fetchCompany(cnpj, dependencies.get);
  const result = await storage.mergeContacts(digits(cnpj), contactsFromCompany(company));
  return {
    ...result,
    remoteTotal: contactsFromCompany(company).length,
    imported: result.added.length
  };
};

const registerCompany = async (input, dependencies = {}) => {
  const storage = dependencies.store || store;
  const company = await fetchCompany(input?.cnpj, dependencies.get);
  const category = await storage.saveCategory({
    cnpj: input?.cnpj,
    name: String(input?.name || '').trim() || companyName(company)
  });
  const synced = await syncCompanyContacts(category.cnpj, { ...dependencies, store: storage, company });
  return { ...synced, category: synced.category || category };
};

const patchGroupContact = (contact) => {
  const result = {};
  const mappings = [
    ['xNome', ['xNome', 'nome']],
    ['email', ['email']],
    ['telefone', ['telefone']],
    ['alertaOcorrencias', ['alertaOcorrencias']],
    ['preAlertaWhatsApp', ['preAlertaWhatsApp']]
  ];
  mappings.forEach(([target, names]) => {
    const value = field(contact, names);
    if (value !== '' && value !== undefined && value !== null) result[target] = value;
  });
  return result;
};

const removeCompanyContact = async (cnpj, email, dependencies = {}) => {
  const normalizedCnpj = digits(cnpj);
  const normalizedEmail = emailKey(email);
  const get = dependencies.get || authenticatedGet;
  const patch = dependencies.patch || authenticatedPatch;
  const company = await fetchCompany(normalizedCnpj, get);
  const currentGroup = groupContacts(company);
  const remaining = currentGroup.filter((contact) => emailKey(field(contact, ['email'])) !== normalizedEmail);
  if (remaining.length === currentGroup.length) return { removed: false };

  const result = await patch('/cadastro/empresas', {
    nCNPJ: normalizedCnpj,
    xGrupo: remaining.map(patchGroupContact)
  });
  if (!result?.response?.ok || Number(result?.payload?.status) === 0) {
    throw upstreamError(result?.payload?.message || 'A Brudam não aceitou a exclusão do contato.');
  }

  const verifiedCompany = await fetchCompany(normalizedCnpj, get);
  const stillExists = groupContacts(verifiedCompany)
    .some((contact) => emailKey(field(contact, ['email'])) === normalizedEmail);
  if (stillExists) {
    throw upstreamError('A Brudam não confirmou a exclusão do contato. O cadastro local foi preservado.');
  }
  return { removed: true };
};

const deleteContact = async (cnpj, id, dependencies = {}) => {
  const storage = dependencies.store || store;
  const category = await storage.getCategory(cnpj);
  if (!category) throw Object.assign(new Error('Empresa não encontrada.'), { statusCode: 404 });
  const contact = category.contacts.find((item) => item.id === String(id || ''));
  if (!contact) throw Object.assign(new Error('Contato não encontrado.'), { statusCode: 404 });
  const remote = await removeCompanyContact(category.cnpj, contact.email, dependencies);
  const deleted = await storage.deleteContact(category.cnpj, contact.id);
  return { deleted, remoteRemoved: remote.removed };
};

module.exports = {
  field,
  companyFromPayload,
  companyName,
  groupContacts,
  contactsFromCompany,
  fetchCompany,
  syncCompanyContacts,
  registerCompany,
  patchGroupContact,
  removeCompanyContact,
  deleteContact
};
