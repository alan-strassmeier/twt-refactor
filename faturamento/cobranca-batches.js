(() => {
  'use strict';

  const MAX_JOINT_ATTACHMENT_BYTES = 18 * 1024 * 1024;
  const MAX_BATCH_WAIT_MS = 5 * 60 * 1000;
  const MAX_PREPARE_ATTEMPTS = 3;

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
    concurrency = 2, now = Date.now, maxAttempts = MAX_PREPARE_ATTEMPTS,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shouldRetry = (invoice, error) => !invoice.removed && error.retryable !== false
      && error.status !== 413 }) => {
    let batch = [];
    let batchBytes = 0;
    let batchStartedAt = null;
    let sentBatches = 0;
    let sentInvoices = 0;
    let errors = 0;
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
    let waiting = invoices;
    for (let attempt = 1; attempt <= maxAttempts && waiting.length; attempt += 1) {
      const current = waiting;
      const deferred = [];
      const pending = new Map();
      let nextToStart = 0;
      const fill = () => {
        while (pending.size < (attempt === 1 ? concurrency : 1) && nextToStart < current.length) {
          const index = nextToStart++;
          pending.set(index, Promise.resolve().then(() => prepare(current[index]))
            .then((bytes) => ({ bytes }), (error) => ({ error })));
        }
      };
      fill();
      for (let index = 0; index < current.length; index += 1) {
        const invoice = current[index];
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
          error.retryable = false;
        }
        if (error) {
          const willRetry = attempt < maxAttempts && shouldRetry(invoice, error);
          await onPrepareError(invoice, error, { attempt, maxAttempts, willRetry });
          if (willRetry) deferred.push({ invoice, error });
          else errors += 1;
          if (batch.length && now() - batchStartedAt >= MAX_BATCH_WAIT_MS) {
            const result = await flush();
            if (result?.status === 'review') return {
              sentBatches, sentInvoices, errors: errors + deferred.length, review: true
            };
          }
          continue;
        }
        if (batch.length && (batchBytes + bytes > MAX_JOINT_ATTACHMENT_BYTES
          || now() - batchStartedAt >= MAX_BATCH_WAIT_MS)) {
          const result = await flush();
          if (result?.status === 'review') return {
            sentBatches, sentInvoices, errors: errors + deferred.length, review: true
          };
        }
        batch.push(invoice);
        batchBytes += bytes;
        batchStartedAt ??= now();
        if (batchBytes === MAX_JOINT_ATTACHMENT_BYTES) {
          const result = await flush();
          if (result?.status === 'review') return {
            sentBatches, sentInvoices, errors: errors + deferred.length, review: true
          };
        }
      }
      const result = await flush();
      if (result?.status === 'review') return {
        sentBatches, sentInvoices, errors: errors + deferred.length, review: true
      };
      waiting = deferred.map(({ invoice }) => invoice);
      if (waiting.length) {
        const limited = deferred.some(({ error }) => error.status === 429);
        await wait(limited ? 5000 * attempt : 1000 * attempt);
      }
    }
    return { sentBatches, sentInvoices, errors, review: false };
  };

  if (typeof window !== 'undefined') window.jointProofNeedsRefresh = jointProofNeedsRefresh;
  if (typeof window !== 'undefined') window.streamJointBillingInvoices = streamJointBillingInvoices;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { jointProofNeedsRefresh, streamJointBillingInvoices,
      MAX_JOINT_ATTACHMENT_BYTES, MAX_BATCH_WAIT_MS };
  }
})();
