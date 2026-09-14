const normalizedMessage = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR')
  .replace(/\s+/g, ' ')
  .trim();

const isTerminalBillingFailure = (value) => {
  const message = normalizedMessage(value?.message || value);
  return (
    message.includes('fatura nao encontrada na brudam') ||
    message.includes('fatura nao foi encontrada na brudam')
  );
};

module.exports = {
  normalizedMessage,
  isTerminalBillingFailure
};
