const TWT_ISSUER_CNPJ = '09123137000108';
const DSL_ISSUER_CNPJ = '97434690000129';
const BANK_SLIP_CREATION_START_DATE = '2026-09-16';
const TWT_BILLING_START_DATE = BANK_SLIP_CREATION_START_DATE;
const AUTOMATIC_BILLING_START_DATE = TWT_BILLING_START_DATE;
const BANK_SLIP_CREATION_BLOCKED_CODE = 'BANK_SLIP_CREATION_BEFORE_CUTOFF';

const BILLING_BANKS = Object.freeze({
  bradesco: Object.freeze({ id: 'bradesco', label: 'Bradesco', issuerCnpj: TWT_ISSUER_CNPJ }),
  itau: Object.freeze({ id: 'itau', label: 'Itaú', issuerCnpj: DSL_ISSUER_CNPJ })
});

const BILLING_METHODS = Object.freeze({
  bankSlip: 'bank_slip',
  tedDoc: 'ted_doc'
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

const requiresTedDocForCategory = (category) =>
  category?.billingMethod === BILLING_METHODS.tedDoc;

const DSL_TED_DOC_ACCOUNT = Object.freeze({
  method: 'TRANSFERENCIA TED/DOC',
  label: 'ITAU- DSL',
  agency: '0602-0',
  account: '16666-2'
});

const DSL_TED_DOC_LIQUIDATION = Object.freeze({
  paymentMethodId: 4,
  bankAccountId: 16666
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

const isBankSlipCreationEligible = ({ issuedAt = '' } = {}) => (
  normalizedDateOnly(issuedAt) >= BANK_SLIP_CREATION_START_DATE
);

const bankSlipBankForIssuer = (value) => {
  if (isTwtIssuer(value)) return BILLING_BANKS.bradesco;
  if (isDslIssuer(value)) return BILLING_BANKS.itau;
  return null;
};

module.exports = {
  TWT_ISSUER_CNPJ,
  DSL_ISSUER_CNPJ,
  BANK_SLIP_CREATION_START_DATE,
  BANK_SLIP_CREATION_BLOCKED_CODE,
  TWT_BILLING_START_DATE,
  AUTOMATIC_BILLING_START_DATE,
  BILLING_BANKS,
  BILLING_METHODS,
  DSL_TED_DOC_ACCOUNT,
  DSL_TED_DOC_LIQUIDATION,
  isTwtIssuer,
  isDslIssuer,
  normalizedDateOnly,
  isTwtBillingEligible,
  isBankSlipCreationEligible,
  bankSlipBankForIssuer,
  normalizedRuleText,
  isTedDocPaymentMethod,
  requiresTedDocForCategory
};
