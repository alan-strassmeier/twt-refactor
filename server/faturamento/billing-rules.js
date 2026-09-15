const TWT_ISSUER_CNPJ = '09123137000108';
const DSL_ISSUER_CNPJ = '97434690000129';
const TWT_BILLING_START_DATE = '2026-09-16';
const BL_POA_CNPJ = '27011022000103';
const WHITE_MARTINS_TED_DOC_CNPJS = Object.freeze([
  '24380578002556',
  '24380578004176',
  '24380578000260',
  '34597955001242',
  '35820448015320',
  '35820448000136',
  '35820448013467',
  '35820448006410'
]);
const ELECNOR_TED_DOC_CNPJS = Object.freeze([
  '30455661000920',
  '30455661002469',
  '30455661002116',
  '30455661002892',
  '30455661001730',
  '30455661001659',
  '30455661001900',
  '30455661001810',
  '30455661003007',
  '30455661002973',
  '30455661002701',
  '30455661003198',
  '30455661002620',
  '30455661000172'
]);
const TED_DOC_CLIENT_CNPJS = new Set([
  BL_POA_CNPJ,
  ...WHITE_MARTINS_TED_DOC_CNPJS,
  ...ELECNOR_TED_DOC_CNPJS
]);

const BILLING_BANKS = Object.freeze({
  bradesco: Object.freeze({ id: 'bradesco', label: 'Bradesco', issuerCnpj: TWT_ISSUER_CNPJ }),
  itau: Object.freeze({ id: 'itau', label: 'Itaú', issuerCnpj: DSL_ISSUER_CNPJ })
});

const digits = (value) => String(value || '').replace(/\D/g, '');

const normalizedRuleText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const isTedDocPaymentMethod = (value) => {
  const normalized = normalizedRuleText(value);
  return normalized.includes('TRANSFERENCIA') || /(?:^| )(?:TED|DOC)(?: |$)/.test(normalized);
};

const isTedDocClient = ({ names = [], document = '' } = {}) => {
  if (TED_DOC_CLIENT_CNPJS.has(digits(document))) return true;
  const values = (Array.isArray(names) ? names : [names]).map(normalizedRuleText);
  return values.some((name) => (
    name.includes('WHITE MARTINS') ||
    name.includes('ELECNOR') ||
    name === 'BL INDUSTRIA OTICA LTDA POA'
  ));
};

const requiresTedDocPayment = ({ clientNames = [], clientDocument = '', paymentMethod = '' } = {}) => (
  isTedDocPaymentMethod(paymentMethod) ||
  isTedDocClient({ names: clientNames, document: clientDocument })
);

const DSL_TED_DOC_ACCOUNT = Object.freeze({
  method: 'TRANSFERENCIA TED/DOC',
  label: 'ITAU- DSL',
  agency: '0602-0',
  account: '16666-2'
});

const isTwtIssuer = (value) => digits(value) === TWT_ISSUER_CNPJ;
const isDslIssuer = (value) => digits(value) === DSL_ISSUER_CNPJ;

const normalizedDateOnly = (value) => {
  const iso = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const brazilian = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return brazilian ? `${brazilian[3]}-${brazilian[2]}-${brazilian[1]}` : '';
};

const isTwtBillingEligible = ({ issuerCnpj = '', issuedAt = '' } = {}) => (
  isTwtIssuer(issuerCnpj) &&
  normalizedDateOnly(issuedAt) >= TWT_BILLING_START_DATE
);

const bankSlipBankForIssuer = (value) => {
  if (isTwtIssuer(value)) return BILLING_BANKS.bradesco;
  if (isDslIssuer(value)) return BILLING_BANKS.itau;
  return null;
};

module.exports = {
  TWT_ISSUER_CNPJ,
  DSL_ISSUER_CNPJ,
  TWT_BILLING_START_DATE,
  BL_POA_CNPJ,
  WHITE_MARTINS_TED_DOC_CNPJS,
  ELECNOR_TED_DOC_CNPJS,
  BILLING_BANKS,
  DSL_TED_DOC_ACCOUNT,
  isTwtIssuer,
  isDslIssuer,
  normalizedDateOnly,
  isTwtBillingEligible,
  bankSlipBankForIssuer,
  normalizedRuleText,
  isTedDocPaymentMethod,
  isTedDocClient,
  requiresTedDocPayment
};
