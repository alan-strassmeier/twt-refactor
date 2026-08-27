'use strict';

const { loadConfig } = require('./config');
const { closePool } = require('./database');
const queue = require('./queue-store');
const { createWorker } = require('./worker');
const { createWebhookServer } = require('./http-server');

const start = async () => {
  const config = loadConfig();
  const { processWebhook } = require('../../server/whatsapp/processor');
  const worker = createWorker({
    queue,
    processWebhook,
    pollMilliseconds: config.pollMilliseconds,
    maxAttempts: config.maxAttempts,
    leaseSeconds: config.workerLeaseSeconds
  });
  const server = createWebhookServer({
    enqueueWebhook: queue.enqueueWebhook,
    isReady: queue.isReady,
    verifyToken: config.verifyToken,
    appSecret: config.appSecret,
    publicPath: config.publicPath,
    maxBodyBytes: config.maxBodyBytes
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  worker.start();
  console.log('[whatsapp:service]', {
    status: 'started',
    port: config.port,
    path: config.publicPath,
    dryRun: config.dryRun,
    allowedSenders: config.allowAllSenders ? 'all' : config.allowedSenderCount
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[whatsapp:service]', { status: 'stopping', signal });
    await new Promise((resolve) => server.close(resolve));
    await worker.stop();
    await closePool();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
    console.error('[whatsapp:shutdown]', { message: error.message });
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
    console.error('[whatsapp:shutdown]', { message: error.message });
    process.exitCode = 1;
  }));

  return { server, worker, shutdown };
};

if (require.main === module) {
  start().catch((error) => {
    console.error('[whatsapp:service]', { status: 'failed', message: error.message });
    process.exitCode = 1;
  });
}

module.exports = { start };
