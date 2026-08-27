(function initBillingSort(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BillingSort = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const accessors = {
    id: (invoice) => invoice.id,
    issuedAt: (invoice) => invoice.issuedAt,
    dueAt: (invoice) => invoice.dueAt,
    paidAt: (invoice) => invoice.paidAt,
    client: (invoice) => invoice.client,
    total: (invoice) => invoice.total,
    paid: (invoice) => invoice.paid,
    balance: (invoice) => invoice.balance,
    status: (invoice) => invoice.statusLabel
  };
  const dateKeys = new Set(['issuedAt', 'dueAt', 'paidAt']);
  const numericKeys = new Set(['id', 'total', 'paid', 'balance']);
  const collator = new Intl.Collator('pt-BR', {
    numeric: true,
    sensitivity: 'base'
  });

  const defaultDirectionFor = (key) => dateKeys.has(key) ? 'desc' : 'asc';

  const comparableValue = (invoice, key) => {
    const value = accessors[key]?.(invoice);
    if (value === undefined || value === null || value === '') return null;
    if (dateKeys.has(key)) {
      const timestamp = Date.parse(String(value));
      return Number.isNaN(timestamp) ? null : timestamp;
    }
    if (numericKeys.has(key)) {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    return String(value).trim();
  };

  const sortInvoices = (invoices, key = 'issuedAt', direction = 'desc') => {
    const factor = direction === 'asc' ? 1 : -1;
    return invoices.map((invoice, index) => ({ invoice, index })).sort((left, right) => {
      const leftValue = comparableValue(left.invoice, key);
      const rightValue = comparableValue(right.invoice, key);
      if (leftValue === null && rightValue === null) return left.index - right.index;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;

      const comparison = typeof leftValue === 'string'
        ? collator.compare(leftValue, rightValue)
        : leftValue - rightValue;
      return comparison === 0 ? left.index - right.index : comparison * factor;
    }).map(({ invoice }) => invoice);
  };

  return {
    defaultDirectionFor,
    sortInvoices
  };
}));
