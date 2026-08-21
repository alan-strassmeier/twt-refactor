'use strict';

const nodemailer = require('nodemailer');

class ErrorMailer {
  constructor({ host, port, secure, user, password, from, to }) {
    this.from = from;
    this.to = to;
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: password }
    });
  }

  async send({ collection, subject, issue, details = [] }) {
    const lines = [
      `Não foi possível concluir automaticamente o encaminhamento da coleta ${collection}.`,
      '',
      `Erro: ${issue}`,
      ...details.map((detail) => `- ${detail}`),
      '',
      `Assunto original: ${subject || '(sem assunto)'}`,
      '',
      'O e-mail original permaneceu registrado na caixa de automação.'
    ];
    await this.transport.sendMail({
      from: this.from,
      to: this.to,
      subject: `[Erro coleta ${collection}] ${issue}`,
      text: lines.join('\n')
    });
  }
}

module.exports = { ErrorMailer };
