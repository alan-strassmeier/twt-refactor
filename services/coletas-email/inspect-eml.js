'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { simpleParser } = require('mailparser');
const { collectionId, pdfAttachments } = require('./email-data');
const { externalDomains, resolveRecipients } = require('./routing');
const { loadContacts } = require('./contacts');

const run = async () => {
  const filename = process.argv[2];
  if (!filename) throw new Error('Uso: npm run coletas:inspect -- caminho-do-arquivo.eml');
  const message = await simpleParser(await readFile(path.resolve(filename)));
  const pdfs = pdfAttachments(message, 100 * 1024 * 1024);
  const domains = externalDomains(message, ['twt.com.br']);
  const contactsFile = process.env.COLETAS_CONTACTS_FILE;
  const routing = contactsFile
    ? resolveRecipients(domains, await loadContacts(path.resolve(contactsFile)))
    : { recipients: [], missingDomains: domains };
  console.log(JSON.stringify({
    subject: message.subject,
    from: message.from?.text,
    collection: collectionId(message, pdfs),
    externalDomains: domains,
    pdfs: pdfs.map((pdf) => ({ filename: pdf.filename, bytes: pdf.content.length })),
    registeredRecipients: routing.recipients.map((recipient) => ({
      domains: recipient.domains,
      company: recipient.company,
      name: recipient.name,
      phoneEnding: recipient.phone.slice(-4)
    })),
    missingDomains: routing.missingDomains
  }, null, 2));
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
