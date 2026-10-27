(() => {
  'use strict';

  const MAX_JOINT_ATTACHMENT_BYTES = 18 * 1024 * 1024;
  const MAX_BATCH_WAIT_MS = 5 * 60 * 1000;

  const jointProofNeedsRefresh = (proof, now = Date.now()) => {
    try {
      const payload = String(proof || '').split('.')[0];
      const decoded = typeof atob === 'function'
        ? atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        : Buffer.from(payload, 'base64url').toString('utf8');
      const checkedAt = JSON.parse(decoded).checkedAt;
      return !Number.isFinite(checkedAt) || checkedAt > now + 60000
        || now - checkedAt >= 22 * 60 * 1000;
    } catch {
      return true;
    }
  };

  const streamJointBillingInvoices = async (invoices, { prepare, send, onPrepareError,
    concurrency = 2, now = Date.now }) => {
    const pending = new Map();
    let nextToStart = 0;
    let batch = [];
    let batchBytes = 0;
    let batchStartedAt = null;
    let sentBatches = 0;
    let sentInvoices = 0;
    let errors = 0;
    const fill = () => {
      while (pending.size < concurrency && nextToStart < invoices.length) {
        const index = nextToStart++;
        pending.set(index, Promise.resolve().then(() => prepare(invoices[index]))
          .then((bytes) => ({ bytes }), (error) => ({ error })));
      }
    };
    const flush = async () => {
      if (!batch.length) return null;
      const ready = batch;
      batch = [];
      batchBytes = 0;
      batchStartedAt = null;
      const result = await send(ready, sentBatches + 1);
      sentBatches += 1;
      sentInvoices += ready.length;
      return result;
    };
    fill();
    for (let index = 0; index < invoices.length; index += 1) {
      const invoice = invoices[index];
      const prepared = await pending.get(index);
      pending.delete(index);
      fill();
      let bytes = prepared?.bytes;
      let error = prepared?.error;
      if (!error && (!Number.isSafeInteger(bytes) || bytes <= 0
        || bytes > MAX_JOINT_ATTACHMENT_BYTES)) {
        error = new Error(bytes > MAX_JOINT_ATTACHMENT_BYTES
          ? `Os anexos da fatura ${invoice.id} ultrapassam 18 MB sozinhos.`
          : `O tamanho dos anexos da fatura ${invoice.id} não foi confirmado.`);
      }
      if (error) {
        errors += 1;
        await onPrepareError(invoice, error);
        if (batch.length && now() - batchStartedAt >= MAX_BATCH_WAIT_MS) {
          const result = await flush();
          if (result?.status === 'review') return { sentBatches, sentInvoices, errors, review: true };
        }
        continue;
      }
      if (batch.length && (batchBytes + bytes > MAX_JOINT_ATTACHMENT_BYTES
        || now() - batchStartedAt >= MAX_BATCH_WAIT_MS)) {
        const result = await flush();
        if (result?.status === 'review') return { sentBatches, sentInvoices, errors, review: true };
      }
      batch.push(invoice);
      batchBytes += bytes;
      batchStartedAt ??= now();
      if (batchBytes === MAX_JOINT_ATTACHMENT_BYTES) {
        const result = await flush();
        if (result?.status === 'review') return { sentBatches, sentInvoices, errors, review: true };
      }
    }
    const result = await flush();
    return { sentBatches, sentInvoices, errors, review: result?.status === 'review' };
  };

  if (typeof window !== 'undefined') window.jointProofNeedsRefresh = jointProofNeedsRefresh;
  if (typeof window !== 'undefined') window.streamJointBillingInvoices = streamJointBillingInvoices;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { jointProofNeedsRefresh, streamJointBillingInvoices,
      MAX_JOINT_ATTACHMENT_BYTES, MAX_BATCH_WAIT_MS };
  }
})();
