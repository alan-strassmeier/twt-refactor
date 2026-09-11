'use strict';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryDelaySeconds = (attempts) =>
  Math.min(15 * 60, Math.max(5, 5 * (2 ** Math.max(0, attempts - 1))));

const createWorker = ({
  queue,
  processWebhook,
  pollMilliseconds = 1000,
  maxAttempts = 8,
  leaseSeconds = 1200
}) => {
  if (leaseSeconds < 900) {
    throw new Error('O lease do worker não pode ser menor que os 900 segundos da deduplicação.');
  }
  let stopping = false;
  let loopPromise;
  let nextMaintenanceAt = 0;

  const runOnce = async () => {
    const item = await queue.claimNext(leaseSeconds);
    if (!item) return false;
    try {
      await processWebhook(item.payload);
      await queue.markDone(item.id);
      console.log('[whatsapp:worker]', { eventId: item.id, status: 'done' });
    } catch (error) {
      const dead = item.attempts >= maxAttempts;
      const delaySeconds = retryDelaySeconds(item.attempts);
      await queue.markFailed(item.id, error, { dead, delaySeconds });
      console.error('[whatsapp:worker]', {
        eventId: item.id,
        status: dead ? 'dead' : 'retry',
        attempts: item.attempts,
        message: error.message
      });
    }
    return true;
  };

  const loop = async () => {
    while (!stopping) {
      try {
        if (queue.cleanupExpired && Date.now() >= nextMaintenanceAt) {
          const removed = await queue.cleanupExpired();
          nextMaintenanceAt = Date.now() + 60 * 60 * 1000;
          if (removed.state || removed.inbox || removed.images?.expired ||
              removed.images?.orphaned || removed.images?.temporaries) {
            console.log('[whatsapp:maintenance]', { removed });
          }
        }
        const processed = await runOnce();
        if (!processed) await delay(pollMilliseconds);
      } catch (error) {
        console.error('[whatsapp:worker-loop]', { message: error.message });
        await delay(Math.max(1000, pollMilliseconds));
      }
    }
  };

  return {
    runOnce,
    start() {
      if (!loopPromise) loopPromise = loop();
    },
    async stop() {
      stopping = true;
      await loopPromise;
    }
  };
};

module.exports = { createWorker, retryDelaySeconds };
