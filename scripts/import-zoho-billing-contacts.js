const fs = require('node:fs');
const path = require('node:path');
const { categoriesFromLdif } = require('../server/faturamento/cobranca-contact-import');

const [, , inputPath, outputPath = path.join(__dirname, '..', 'server', 'faturamento', 'cobranca-contacts-seed.json')] = process.argv;
if (!inputPath) {
  console.error('Uso: node scripts/import-zoho-billing-contacts.js <contatos.ldif> [saida.json]');
  process.exitCode = 1;
} else {
  const content = fs.readFileSync(path.resolve(inputPath), 'utf8');
  const categories = categoriesFromLdif(content);
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(categories, null, 2)}\n`, 'utf8');
  const contacts = categories.reduce((total, category) => total + category.contacts.length, 0);
  console.log(`Importadas ${categories.length} empresas e ${contacts} associações de contatos.`);
}
