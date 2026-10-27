(() => {
  'use strict';

  const MAX_JOINT_ATTACHMENT_BYTES = 18 * 1024 * 1024;

  const splitJointBillingInvoices = (invoices) => {
    if (!Array.isArray(invoices) || !invoices.length) return [];
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const invoice of invoices) {
      const size = Number(invoice?.preparedBytes);
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new Error(`O tamanho dos anexos da fatura ${invoice?.id || '?'} não foi confirmado. Tente prepará-la novamente.`);
      }
      if (size > MAX_JOINT_ATTACHMENT_BYTES) {
        throw new Error(`Os anexos da fatura ${invoice.id} ultrapassam 18 MB sozinhos; não é possível dividi-los entre e-mails.`);
      }
      if (current.length && currentBytes + size > MAX_JOINT_ATTACHMENT_BYTES) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(invoice);
      currentBytes += size;
    }
    if (current.length) batches.push(current);
    return batches;
  };

  if (typeof window !== 'undefined') window.splitJointBillingInvoices = splitJointBillingInvoices;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { splitJointBillingInvoices, MAX_JOINT_ATTACHMENT_BYTES };
  }
})();
