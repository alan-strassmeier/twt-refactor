'use strict';

class WhatsAppDocuments {
  constructor({ accessToken, phoneNumberId, graphVersion = 'v25.0' }) {
    if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN não configurado.');
    if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID não configurado.');
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.baseUrl = `https://graph.facebook.com/${graphVersion}`;
  }

  async request(pathname, options) {
    const response = await fetch(`${this.baseUrl}/${pathname}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers || {}) },
      signal: AbortSignal.timeout(30000)
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`WhatsApp respondeu ${response.status}: ${body.slice(0, 500)}`);
    }
    return body ? JSON.parse(body) : {};
  }

  async uploadPdf(pdf) {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', 'application/pdf');
    form.set('file', new Blob([pdf.content], { type: 'application/pdf' }), pdf.filename);
    const result = await this.request(`${this.phoneNumberId}/media`, {
      method: 'POST',
      body: form
    });
    if (!result.id) throw new Error('O WhatsApp não retornou o ID do PDF enviado.');
    return result.id;
  }

  async sendPdf(to, mediaId, filename) {
    const result = await this.request(`${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: { id: mediaId, filename }
      })
    });
    return result.messages?.[0]?.id || '';
  }
}

module.exports = { WhatsAppDocuments };
