'use strict';

const { createHash } = require('node:crypto');
const { addressesFor, externalDomains, resolveRecipients } = require('./routing');
const { collectionId, messageKey, pdfAttachments } = require('./email-data');

class RetryableProcessingError extends Error {}

const keyFor = (...values) => createHash('sha256').update(values.join('|')).digest('hex');

const senderAddresses = (message) => addressesFor(message.from).map((value) => value.toLowerCase());

const alertOnce = async (state, mailer, key, payload) => {
  if (state.wasAlerted(key)) return;
  await mailer.send(payload);
  await state.markAlerted(key);
};

const processCollectionEmail = async (message, dependencies) => {
  const {
    allowedSenders,
    internalDomains,
    maxPdfBytes,
    maxAttempts,
    registry,
    state,
    whatsapp,
    mailer
  } = dependencies;

  const senders = senderAddresses(message);
  if (!senders.some((sender) => allowedSenders.includes(sender))) {
    return { ignored: true, reason: `Remetente não autorizado: ${senders.join(', ') || '(ausente)'}` };
  }

  const pdfs = pdfAttachments(message, maxPdfBytes);
  const collection = collectionId(message, pdfs);
  const emailKey = messageKey(message, pdfs);
  const domains = externalDomains(message, internalDomains);

  if (!pdfs.length) {
    await alertOnce(state, mailer, keyFor(emailKey, 'no-pdf'), {
      collection,
      subject: message.subject,
      issue: 'PDF da coleta ausente ou inválido'
    });
    return { collection, sent: 0, missingDomains: domains, terminalError: true };
  }

  if (!domains.length) {
    await alertOnce(state, mailer, keyFor(emailKey, 'no-domain'), {
      collection,
      subject: message.subject,
      issue: 'Nenhum domínio externo foi encontrado em Para ou CC'
    });
    return { collection, sent: 0, missingDomains: [], terminalError: true };
  }

  const { recipients, missingDomains } = resolveRecipients(domains, registry);
  if (missingDomains.length) {
    await alertOnce(state, mailer, keyFor(emailKey, 'missing', ...missingDomains), {
      collection,
      subject: message.subject,
      issue: 'Domínio sem contato cadastrado',
      details: missingDomains.map((domain) => `Cadastrar um contato para ${domain}`)
    });
  }

  let sent = 0;
  for (const pdf of pdfs) {
    const pending = recipients.filter((recipient) => !state.wasDelivered(
      keyFor(emailKey, pdf.hash, recipient.phone)
    ));
    if (!pending.length) continue;

    let mediaId;
    const uploadKey = keyFor(emailKey, pdf.hash, 'upload');
    try {
      mediaId = await whatsapp.uploadPdf(pdf);
    } catch (error) {
      const attempts = await state.registerFailure(uploadKey, error);
      if (attempts < maxAttempts) throw new RetryableProcessingError(error.message);
      await alertOnce(state, mailer, keyFor(uploadKey, 'failed'), {
        collection,
        subject: message.subject,
        issue: 'Falha ao carregar o PDF no WhatsApp após as tentativas automáticas',
        details: [error.message]
      });
      continue;
    }

    for (const recipient of pending) {
      const deliveryKey = keyFor(emailKey, pdf.hash, recipient.phone);
      try {
        const whatsappMessageId = await whatsapp.sendPdf(recipient.phone, mediaId, pdf.filename);
        await state.markDelivered(deliveryKey, {
          collection,
          filename: pdf.filename,
          phone: recipient.phone,
          domains: recipient.domains,
          whatsappMessageId
        });
        sent += 1;
      } catch (error) {
        const attempts = await state.registerFailure(deliveryKey, error);
        if (attempts < maxAttempts) throw new RetryableProcessingError(error.message);
        await alertOnce(state, mailer, keyFor(deliveryKey, 'failed'), {
          collection,
          subject: message.subject,
          issue: `Falha ao enviar o PDF para ${recipient.company}`,
          details: [`Domínio: ${recipient.domains.join(', ')}`, `WhatsApp: ${recipient.phone}`, error.message]
        });
      }
    }
  }

  return { collection, sent, domains, missingDomains };
};

module.exports = { processCollectionEmail, RetryableProcessingError };
