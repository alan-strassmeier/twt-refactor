'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHmac } = require('node:crypto');

const { createWebhookServer } = require('../services/whatsapp-baixa/http-server');
const { createWorker, retryDelaySeconds } = require('../services/whatsapp-baixa/worker');
const { loadConfig } = require('../services/whatsapp-baixa/config');
const runtime = require('../server/whatsapp/runtime');
const meta = require('../server/whatsapp/meta');
const brudam = require('../server/whatsapp/brudam');
const { createImageStore } = require('../services/whatsapp-baixa/proof-image-store');

const withEnvironment = async (values, action) => {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
};

const close = (server) => new Promise((resolve) => server.close(resolve));

test('servidor valida GET, assinatura e persiste antes do HTTP 200', async () => {
  const queued = [];
  const secret = 'segredo-local-de-teste';
  const server = createWebhookServer({
    enqueueWebhook: async (eventKey, payload) => queued.push({ eventKey, payload }),
    isReady: async () => true,
    verifyToken: 'token-verificacao',
    appSecret: secret
  });
  const base = await listen(server);
  try {
    const verification = await fetch(
      `${base}/api/whatsapp?hub.mode=subscribe&hub.verify_token=token-verificacao&hub.challenge=12345`
    );
    assert.equal(verification.status, 200);
    assert.equal(await verification.text(), '12345');

    const rejected = await fetch(`${base}/api/whatsapp`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
      body: '{}'
    });
    assert.equal(rejected.status, 401);
    assert.equal(queued.length, 0);

    const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const accepted = await fetch(`${base}/api/whatsapp`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body: raw
    });
    assert.equal(accepted.status, 200);
    assert.equal(await accepted.text(), 'EVENT_RECEIVED');
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].payload.entry, []);
    assert.match(queued[0].eventKey, /^[a-f0-9]{64}$/);
  } finally {
    await close(server);
  }
});

test('healthcheck distingue processo vivo de dependências prontas', async () => {
  const server = createWebhookServer({
    enqueueWebhook: async () => {},
    isReady: async () => false,
    verifyToken: 'token',
    appSecret: 'secret'
  });
  const base = await listen(server);
  try {
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
  } finally {
    await close(server);
  }
});

test('worker conclui evento e agenda retentativa sem perder o payload', async () => {
  const events = [
    { id: 1, payload: { ok: true }, attempts: 1 },
    { id: 2, payload: { fail: true }, attempts: 2 }
  ];
  const done = [];
  const failed = [];
  const queue = {
    claimNext: async () => events.shift() || null,
    markDone: async (id) => done.push(id),
    markFailed: async (id, error, options) => failed.push({ id, error, options })
  };
  const worker = createWorker({
    queue,
    processWebhook: async (payload) => {
      if (payload.fail) throw new Error('falha sintética');
    },
    maxAttempts: 8,
    leaseSeconds: 1200
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(done, [1]);
  assert.equal(failed[0].id, 2);
  assert.equal(failed[0].options.dead, false);
  assert.equal(failed[0].options.delaySeconds, retryDelaySeconds(2));
});

test('runtime exige allowlist no serviço e normaliza o telefone', async () => {
  await withEnvironment({
    WHATSAPP_ENFORCE_ALLOWLIST: 'true',
    WHATSAPP_ALLOW_ALL_SENDERS: 'false',
    WHATSAPP_ALLOWED_SENDERS: '+55 (51) 99999-1111'
  }, async () => {
    assert.equal(runtime.isSenderAllowed('5551999991111'), true);
    assert.equal(runtime.isSenderAllowed('5551888882222'), false);
    assert.equal(runtime.redactedPhone('5551999991111'), '***1111');
  });
});

test('configuração própria exige dry-run explícito e lease seguro', async () => {
  const base = {
    DATABASE_URL: 'postgres://local:local@localhost/local',
    WHATSAPP_DRY_RUN: 'true',
    WHATSAPP_ENFORCE_ALLOWLIST: 'true',
    WHATSAPP_ALLOW_ALL_SENDERS: 'false',
    WHATSAPP_ALLOWED_SENDERS: '5551999991111',
    WHATSAPP_STATE_STORE: 'postgres',
    WHATSAPP_IMAGE_STORE: 'filesystem',
    WHATSAPP_IMAGE_STORAGE_PATH: 'C:\\temp\\whatsapp-test',
    WHATSAPP_IMAGE_RETENTION_DAYS: '30',
    WHATSAPP_IMAGE_MIN_FREE_BYTES: '1073741824',
    WHATSAPP_VERIFY_TOKEN: 'verify',
    WHATSAPP_APP_SECRET: 'secret',
    WHATSAPP_SEND_REPLIES: 'true',
    WHATSAPP_ACCESS_TOKEN: 'access-token',
    WHATSAPP_PHONE_NUMBER_ID: '123456789',
    WHATSAPP_RECEIVER_FLOW_ID: '123456789',
    WHATSAPP_DELIVERY_TIME_FLOW_ID: '987654321',
    BRUDAM_API_USER: 'a'.repeat(32),
    BRUDAM_API_PASSWORD: 'b'.repeat(64),
    WHATSAPP_WORKER_LEASE_SECONDS: '1200'
  };
  await withEnvironment(base, async () => {
    assert.equal(loadConfig().dryRun, true);
    process.env.WHATSAPP_WORKER_LEASE_SECONDS = '899';
    assert.throws(() => loadConfig(), /900/);
  });
});

test('dry-run não chama POST da Meta nem cria ocorrência na Brudam', async () => {
  await withEnvironment({
    WHATSAPP_DRY_RUN: 'true',
    WHATSAPP_SEND_REPLIES: 'true'
  }, async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('fetch não deveria ser chamado em dry-run');
    };
    try {
      const sent = await meta.sendText('5551999991111', 'teste');
      assert.equal(sent.simulated, true);
      const occurrence = await brudam.createDeliveryOccurrence({
        minuta: 123,
        timestamp: '2026-08-25 12:00:00',
        driverName: 'Teste',
        senderPhone: '5551999991111',
        messageId: 'wamid.test',
        proof: {
          receiverName: 'Recebedor',
          receiverDocument: '123',
          receiverRelationship: 'Porteiro'
        },
        barcode: { text: '4'.repeat(44), format: 'Code128' }
      });
      assert.equal(occurrence.simulated, true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('armazena comprovante privadamente e confere sua integridade', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-proof-'));
  let stored;
  const pool = {
    async query(sql, parameters) {
      if (/INSERT INTO whatsapp_baixa\.proof_images/.test(sql)) {
        stored = {
          message_id: parameters[0],
          file_name: parameters[1],
          mime_type: parameters[2],
          sha256: parameters[4]
        };
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT file_name, mime_type, sha256/.test(sql)) {
        return { rowCount: stored ? 1 : 0, rows: stored ? [stored] : [] };
      }
      throw new Error('Consulta inesperada no teste.');
    }
  };
  try {
    const imageStore = createImageStore({ pool, storagePath: directory, retentionDays: 30 });
    const bytes = Buffer.from('imagem-de-comprovante');
    const saved = await imageStore.saveProofImage({
      messageId: 'wamid.teste-arquivo',
      bytes,
      mimeType: 'image/jpeg'
    });
    assert.match(saved.fileName, /^[a-f0-9]{64}\.jpg$/);
    const loaded = await imageStore.loadProofImage('wamid.teste-arquivo');
    assert.deepEqual(loaded.bytes, bytes);
    assert.equal(loaded.mimeType, 'image/jpeg');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manutenção exclui arquivo e metadado depois da retenção', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-expired-'));
  const fileName = `${'a'.repeat(64)}.jpg`;
  fs.writeFileSync(path.join(directory, fileName), 'expirado');
  let metadataDeleted = false;
  const pool = {
    async query(sql) {
      if (/SELECT message_id, file_name/.test(sql)) {
        return { rowCount: 1, rows: [{ message_id: 'wamid.expirado', file_name: fileName }] };
      }
      if (/DELETE FROM whatsapp_baixa\.proof_images/.test(sql)) {
        metadataDeleted = true;
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Consulta inesperada no teste.');
    }
  };
  try {
    const imageStore = createImageStore({ pool, storagePath: directory, retentionDays: 30 });
    const removed = await imageStore.cleanupExpiredImages();
    assert.deepEqual(removed, { expired: 1, orphaned: 0, temporaries: 0 });
    assert.equal(metadataDeleted, true);
    assert.equal(fs.existsSync(path.join(directory, fileName)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('migrações são aditivas e não contêm comandos destrutivos', () => {
  const directory = path.join(__dirname, '../services/whatsapp-baixa/migrations');
  const sql = fs.readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => fs.readFileSync(path.join(directory, file), 'utf8'))
    .join('\n');
  assert.match(sql, /CREATE TABLE whatsapp_baixa\.webhook_inbox/);
  assert.match(sql, /CREATE TABLE whatsapp_baixa\.state_kv/);
  assert.match(sql, /CREATE TABLE whatsapp_baixa\.proof_images/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE|ALTER)\b/i);
});
