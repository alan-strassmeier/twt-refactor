const TWT_ISSUER_CNPJ = '09123137000108';
const DSL_ISSUER_CNPJ = '97434690000129';

const BILLING_BANKS = Object.freeze({
  c6: Object.freeze({ id: 'c6', label: 'C6', issuerCnpj: TWT_ISSUER_CNPJ }),
  itau: Object.freeze({ id: 'itau', label: 'Itaú', issuerCnpj: DSL_ISSUER_CNPJ })
});

const digits = (value) => String(value || '').replace(/\D/g, '');

const isTwtIssuer = (value) => digits(value) === TWT_ISSUER_CNPJ;
const isDslIssuer = (value) => digits(value) === DSL_ISSUER_CNPJ;

const bankSlipBankForIssuer = (value) => {
  if (isTwtIssuer(value)) return BILLING_BANKS.c6;
  if (isDslIssuer(value)) return BILLING_BANKS.itau;
  return null;
};

module.exports = {
  TWT_ISSUER_CNPJ,
  DSL_ISSUER_CNPJ,
  BILLING_BANKS,
  isTwtIssuer,
  isDslIssuer,
  bankSlipBankForIssuer
};
