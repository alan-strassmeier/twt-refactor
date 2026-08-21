'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { loadConfig } = require('./config');
const { loadContacts } = require('./contacts');
const { ErrorMailer } = require('./mailer');
const { processCollectionEmail } = require('./processor');
const { StateStore } = require('./state-store');
const { WhatsAppDocuments } = require('./whatsapp');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const start = async () => {
  const config = loadConfig();
  const state = new StateStore(config.stateFile);
  await state.load();
  const whatsapp = new WhatsAppDocuments(config.whatsapp);
  const mailer = new ErrorMailer(config.smtp);
  let stopping = false;

  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopping) {
    const client = new ImapFlow(config.imap);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(config.mailbox);
      try {
        const highestUid = Math.max(0, Number(client.mailbox.uidNext || 1) - 1);
        let cursor = state.getCursor();
        if (cursor === null) {
          cursor = config.processExisting ? 0 : highestUid;
          await state.setCursor(cursor);
          console.log(`[coletas] cursor inicial: ${cursor}`);
        }

        if (cursor < highestUid) {
          const uids = await client.search({ uid: `${cursor + 1}:${highestUid}` }, { uid: true }) || [];
          for (const uid of uids.sort((a, b) => a - b)) {
            const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
            if (!fetched?.source) throw new Error(`Não foi possível ler o e-mail UID ${uid}.`);
            const message = await simpleParser(fetched.source);
            const registry = await loadContacts(config.contactsFile);
            const result = await processCollectionEmail(message, {
              ...config,
              registry,
              state,
              whatsapp,
              mailer
            });
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            await state.setCursor(uid);
            console.log('[coletas] processado', { uid, ...result });
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (error) {
      console.error('[coletas] falha no ciclo:', error);
      try { await client.logout(); } catch {}
    }
    if (!stopping) await delay(config.pollIntervalMs);
  }
};

start().catch((error) => {
  console.error('[coletas] falha fatal:', error);
  process.exitCode = 1;
});
