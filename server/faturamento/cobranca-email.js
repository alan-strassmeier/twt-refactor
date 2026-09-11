const nodemailer = require('nodemailer');

const EVENT_TYPES = Object.freeze({
  initial: 'initial',
  reminder: 'reminder',
  overdue: 'overdue'
});

const htmlEscape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatDate = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || '—');
};

const formatCurrency = (value) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL'
}).format(Number(value) || 0);

const formatCnpj = (value) => {
  const number = String(value || '').replace(/\D/g, '');
  return number.length === 14
    ? number.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : String(value || '');
};

const zohoConfig = (env = process.env) => {
  const host = String(env.ZOHO_SMTP_HOST || 'smtppro.zoho.com').trim();
  const port = Number(env.ZOHO_SMTP_PORT || 465);
  const user = String(env.ZOHO_SMTP_USER || '').trim();
  const password = String(env.ZOHO_SMTP_PASSWORD || '').trim();
  const fromEmail = String(env.ZOHO_SMTP_FROM_EMAIL || user).trim();
  const fromName = String(env.ZOHO_SMTP_FROM_NAME || 'TWT LOG').trim();
  const alertCopy = String(env.BILLING_ALERT_COPY || 'adriano@twt.com.br').trim();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !fromEmail) {
    throw Object.assign(new Error('Envio de cobrança pelo Zoho não configurado.'), {
      statusCode: 503,
      expose: true
    });
  }
  return {
    host,
    port,
    secure: String(env.ZOHO_SMTP_SECURE ?? (port === 465)).toLocaleLowerCase('pt-BR') !== 'false',
    user,
    password,
    fromEmail,
    fromName: fromName || 'TWT LOG',
    alertCopy
  };
};

const createZohoTransport = (config = zohoConfig()) => nodemailer.createTransport({
  host: config.host,
  port: config.port,
  secure: config.secure,
  pool: true,
  maxConnections: 2,
  maxMessages: 40,
  auth: {
    user: config.user,
    pass: config.password
  },
  tls: { servername: config.host }
});

const clientDisplay = (data) => {
  const name = data.client?.tradeName || data.client?.name || 'Não informado';
  return `${name} — ${formatCnpj(data.client?.document)}`;
};

const paymentDisplay = (data) => data.invoice?.payment?.type === 'ted_doc'
  ? 'Transferência TED/DOC'
  : 'Boleto bancário';

const billingSubject = (event, data) => event === EVENT_TYPES.overdue
  ? 'Aviso de Fatura Vencida - TWT LOG'
  : `Fatura : ${data.invoice.id} Vecto: ${formatDate(data.invoice.dueAt)} - TWT LOG`;

const billingText = (event, data, contact) => {
  const lines = ['Aviso de Faturamento'];
  if (event === EVENT_TYPES.reminder) lines.push('Perto do vencimento');
  lines.push('', `Prezado(a), ${contact.firstName}`);
  if (event === EVENT_TYPES.overdue) {
    lines.push(`A fatura ${data.invoice.id} anexada neste e-mail encontra-se vencida.`);
  } else {
    lines.push('Segue fatura em anexo.');
    lines.push(`Vencimento: ${formatDate(data.invoice.dueAt)}`);
  }
  lines.push(
    `Forma de pagamento: ${paymentDisplay(data)}`,
    `Valor: ${formatCurrency(data.invoice.total)}`,
    `Cliente: ${clientDisplay(data)}.`
  );
  return lines.join('\n');
};

const billingHtml = (event, data, contact) => {
  const overdue = event === EVENT_TYPES.overdue;
  const reminder = event === EVENT_TYPES.reminder;
  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:24px;background:#f2f6f9;color:#1a3145;font-family:Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border:1px solid #d8e3ec;border-radius:12px">
      <tr><td style="padding:26px 30px 14px;border-bottom:4px solid #267fca">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#267fca;text-transform:uppercase">TWT LOG</div>
        <h1 style="margin:7px 0 0;font-size:24px;color:#112a40">Aviso de Faturamento</h1>
        ${reminder ? '<p style="margin:10px 0 0;color:#a96512;font-weight:700">Perto do vencimento</p>' : ''}
      </td></tr>
      <tr><td style="padding:24px 30px 30px">
        <p style="margin:0 0 18px">Prezado(a), ${htmlEscape(contact.firstName)}</p>
        <p style="margin:0 0 20px">${overdue
          ? `A fatura <strong>${htmlEscape(data.invoice.id)}</strong> anexada neste e-mail encontra-se vencida.`
          : 'Segue fatura em anexo.'}</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
          ${overdue ? '' : `<tr><td style="padding:9px 0;color:#66798a">Vencimento</td><td style="padding:9px 0;text-align:right;font-weight:700">${htmlEscape(formatDate(data.invoice.dueAt))}</td></tr>`}
          <tr><td style="padding:9px 0;border-top:1px solid #e6edf2;color:#66798a">Forma de pagamento</td><td style="padding:9px 0;border-top:1px solid #e6edf2;text-align:right;font-weight:700">${htmlEscape(paymentDisplay(data))}</td></tr>
          <tr><td style="padding:9px 0;border-top:1px solid #e6edf2;color:#66798a">Valor</td><td style="padding:9px 0;border-top:1px solid #e6edf2;text-align:right;font-weight:700">${htmlEscape(formatCurrency(data.invoice.total))}</td></tr>
          <tr><td style="padding:9px 0;border-top:1px solid #e6edf2;color:#66798a">Cliente</td><td style="padding:9px 0;border-top:1px solid #e6edf2;text-align:right;font-weight:700">${htmlEscape(clientDisplay(data))}</td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
};

const billingAttachments = ({ invoiceId, invoicePdf, dactePdf, bankSlipPdf }) => [
  {
    filename: `fatura-${invoiceId}.pdf`,
    content: invoicePdf,
    contentType: 'application/pdf'
  },
  ...(dactePdf ? [{
    filename: `dactes-fatura-${invoiceId}.pdf`,
    content: dactePdf,
    contentType: 'application/pdf'
  }] : []),
  ...(bankSlipPdf ? [{
    filename: `boleto-fatura-${invoiceId}.pdf`,
    content: bankSlipPdf,
    contentType: 'application/pdf'
  }] : [])
];

const sendBillingEmail = async ({
  event,
  data,
  contact,
  invoicePdf,
  dactePdf = null,
  bankSlipPdf = null,
  transport,
  config = zohoConfig()
}) => {
  const activeTransport = transport || createZohoTransport(config);
  const copyAlert = event === EVENT_TYPES.reminder || event === EVENT_TYPES.overdue;
  const info = await activeTransport.sendMail({
    disableFileAccess: true,
    disableUrlAccess: true,
    from: { name: config.fromName, address: config.fromEmail },
    to: { name: [contact.firstName, contact.lastName].filter(Boolean).join(' '), address: contact.email },
    ...(copyAlert && config.alertCopy ? { cc: config.alertCopy } : {}),
    subject: billingSubject(event, data),
    text: billingText(event, data, contact),
    html: billingHtml(event, data, contact),
    attachments: billingAttachments({
      invoiceId: data.invoice.id,
      invoicePdf,
      dactePdf,
      bankSlipPdf
    })
  });
  const accepted = Array.isArray(info.accepted) ? info.accepted.map(String) : [];
  const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : [];
  if (rejected.some((email) => email.toLocaleLowerCase('pt-BR') === contact.email.toLocaleLowerCase('pt-BR'))) {
    throw Object.assign(new Error('O servidor SMTP rejeitou o destinatário da cobrança.'), {
      statusCode: 502,
      expose: true
    });
  }
  return {
    messageId: String(info.messageId || ''),
    accepted,
    rejected,
    response: String(info.response || '')
  };
};

module.exports = {
  EVENT_TYPES,
  htmlEscape,
  formatDate,
  formatCurrency,
  formatCnpj,
  zohoConfig,
  createZohoTransport,
  clientDisplay,
  paymentDisplay,
  billingSubject,
  billingText,
  billingHtml,
  billingAttachments,
  sendBillingEmail
};
