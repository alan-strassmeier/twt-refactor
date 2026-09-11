const { createHash } = require('node:crypto');

const digits = (value) => String(value || '').replace(/\D/g, '');

const cleanLdifValue = (value) => String(value || '')
  .trim()
  .replace(/^\\?['"]+|\\?['"]+$/g, '')
  .replace(/\\([,+'"\\<>;=#])/g, '$1')
  .trim();

const titleCase = (value) => String(value || '')
  .trim()
  .toLocaleLowerCase('pt-BR')
  .replace(/(^|[\s'-])([\p{L}])/gu, (_, prefix, letter) => `${prefix}${letter.toLocaleUpperCase('pt-BR')}`);

const namesFromEmail = (email) => {
  const localPart = String(email || '').trim().split('@')[0] || '';
  const parts = localPart.split(/[._-]+/).map(cleanLdifValue).filter(Boolean);
  return {
    firstName: titleCase(parts.shift() || localPart),
    lastName: titleCase(parts.join(' '))
  };
};

const normalizeContactNames = ({ firstName, lastName, email }) => {
  let normalizedFirstName = cleanLdifValue(firstName);
  let normalizedLastName = cleanLdifValue(lastName);
  if (!normalizedFirstName) return namesFromEmail(email);

  if (!normalizedLastName) {
    const parts = normalizedFirstName.split(/\s+/).filter(Boolean);
    normalizedFirstName = parts.shift() || '';
    normalizedLastName = parts.join(' ');
  }

  return {
    firstName: titleCase(normalizedFirstName),
    lastName: titleCase(normalizedLastName)
  };
};

const contactId = (cnpj, email) => createHash('sha256')
  .update(`${digits(cnpj)}|${String(email || '').trim().toLocaleLowerCase('pt-BR')}`)
  .digest('hex')
  .slice(0, 20);

const unfoldLdif = (content) => String(content || '')
  .replace(/\r\n?/g, '\n')
  .replace(/\n[ \t]/g, '');

const decodeLdifValue = (separator, value) => {
  if (separator !== '::') return cleanLdifValue(value);
  try {
    return cleanLdifValue(Buffer.from(String(value || '').trim(), 'base64').toString('utf8'));
  } catch {
    return '';
  }
};

const parseLdifRecords = (content) => unfoldLdif(content)
  .split(/\n{2,}/)
  .map((block) => {
    const record = {};
    block.split('\n').forEach((line) => {
      const match = line.match(/^([^:]+)(::?)\s*(.*)$/);
      if (!match) return;
      const key = match[1].trim().toLocaleLowerCase('pt-BR');
      const value = decodeLdifValue(match[2], match[3]);
      if (!value) return;
      if (!record[key]) record[key] = [];
      record[key].push(value);
    });
    return record;
  })
  .filter((record) => Object.keys(record).length > 0);

const categoriesFromValue = (value) => {
  const categories = [];
  const pattern = /(?:^|,)\s*(\d{14})\s*-\s*(.*?)(?=,\s*\d{14}\s*-|$)/g;
  for (const match of String(value || '').matchAll(pattern)) {
    categories.push({ cnpj: match[1], name: cleanLdifValue(match[2]) });
  }
  return categories;
};

const categoriesFromLdif = (content) => {
  const companies = new Map();
  parseLdifRecords(content).forEach((record) => {
    if (!Array.isArray(record.categories) || record.categories.length === 0) return;
    const email = String(record.mail?.[0] || '').trim().toLocaleLowerCase('pt-BR');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    const names = normalizeContactNames({
      firstName: record.givenname?.[0] || record.cn?.[0],
      lastName: record.sn?.[0],
      email
    });

    record.categories.flatMap(categoriesFromValue).forEach(({ cnpj, name }) => {
      const company = companies.get(cnpj) || { cnpj, name, contacts: new Map() };
      if (!company.name && name) company.name = name;
      company.contacts.set(email, {
        id: contactId(cnpj, email),
        firstName: names.firstName,
        lastName: names.lastName,
        email
      });
      companies.set(cnpj, company);
    });
  });

  return [...companies.values()]
    .map((company) => ({
      cnpj: company.cnpj,
      name: company.name,
      contacts: [...company.contacts.values()].sort((left, right) =>
        left.firstName.localeCompare(right.firstName, 'pt-BR'))
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
};

module.exports = {
  digits,
  titleCase,
  namesFromEmail,
  normalizeContactNames,
  contactId,
  parseLdifRecords,
  categoriesFromValue,
  categoriesFromLdif
};
