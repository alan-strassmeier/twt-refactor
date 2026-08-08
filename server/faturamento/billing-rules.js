const TWT_ISSUER_CNPJ = '09123137000108';

const digits = (value) => String(value || '').replace(/\D/g, '');

const isTwtIssuer = (value) => digits(value) === TWT_ISSUER_CNPJ;

module.exports = {
  TWT_ISSUER_CNPJ,
  isTwtIssuer
};
