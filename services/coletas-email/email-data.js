'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const safeFilename = (value, fallback = 'coleta.pdf') => {
  const base = path.basename(String(value || fallback)).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
};

const pdfAttachments = (message, maxBytes) => (message.attachments || [])
  .filter((attachment) => {
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content || '');
    return content.subarray(0, 5).toString('ascii') === '%PDF-' && content.length <= maxBytes;
  })
  .map((attachment) => ({
    content: attachment.content,
    filename: safeFilename(attachment.filename),
    hash: sha256(attachment.content)
  }));

const collectionId = (message, pdfs = []) => {
  const values = [message.subject, ...pdfs.map((pdf) => pdf.filename)];
  for (const value of values) {
    const match = String(value || '').match(/coleta[_\s-]*(\d{1,12})/i);
    if (match) return match[1];
  }
  return 'não identificada';
};

const messageKey = (message, pdfs) => {
  if (message.messageId) return sha256(String(message.messageId).trim().toLowerCase());
  return sha256(JSON.stringify({
    subject: message.subject || '',
    date: message.date?.toISOString?.() || '',
    from: message.from?.text || '',
    pdfs: pdfs.map((pdf) => pdf.hash)
  }));
};

module.exports = { collectionId, messageKey, pdfAttachments, safeFilename, sha256 };
