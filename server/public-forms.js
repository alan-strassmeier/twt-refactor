const SITE_EMAIL = 'twt@twt.com.br';
const MAX_BODY_BYTES = 12_000;
const MAX_SENDS_PER_HOUR = 5;
const RATE_WINDOW_SECONDS = 60 * 60;

const localLimits = new Map();

const FIELDS = Object.freeze({
  contact: [
    ['Nome', 'Nome', 120],
    ['Email', 'E-mail', 254],
    ['Cidade', 'Cidade', 100],
    ['Estado', 'Estado', 40],
    ['subject', 'Assunto', 120],
    ['Mensagem', 'Mensagem', 5_000]
  ],
  quotation: [
    ['Nome', 'Nome', 120],
    ['Email', 'E-mail', 254],
    ['Telefone', 'Telefone', 24],
    ['Empresa', 'Empresa', 120],
    ['Origem', 'Origem', 120],
    ['Destino', 'Destino', 120],
    ['Quantidade', 'Quantidade/Volume', 40],
    ['Peso', 'Peso (kg)', 40],
    ['Largura', 'Largura (cm)', 40],
    ['Altura', 'Altura (cm)', 40],
    ['Comprimento', 'Comprimento (cm)', 40],
    ['ValorNf', 'Valor da NF', 40],
    ['remetente', 'CPF/CNPJ remetente', 18],
    ['destinatario', 'CPF/CNPJ destinatário', 18],
    ['Descricao', 'Descrição do conteúdo', 5_000]
  ]
});

const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const documentIsValid = (value) => {
  const digits = value.replace(/\D/g, '');
  if (/^(\d)\1+$/.test(digits)) return false;
  if (digits.length === 11) {
    const digit = (length) => {
      const sum = [...digits.slice(0, length)].reduce(
        (total, number, index) => total + Number(number) * (length + 1 - index), 0
      );
      return (sum * 10) % 11 % 10;
    };
    return digit(9) === Number(digits[9]) && digit(10) === Number(digits[10]);
  }
  if (digits.length === 14) {
    const digit = (base, weights) => {
      const sum = [...base].reduce(
        (total, number, index) => total + Number(number) * weights[index], 0
      );
      const remainder = sum % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };
    const first = digit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const second = digit(`${digits.slice(0, 12)}${first}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return `${first}${second}` === digits.slice(-2);
  }
  return false;
};

const validateSubmission = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Dados inválidos.');
  const { kind, fields } = payload;
  const definitions = FIELDS[kind];
  if (!definitions || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    fail('Formulário inválido.');
  }

  const clean = {};
  for (const [name, label, maxLength] of definitions) {
    const raw = fields[name];
    if (typeof raw !== 'string') fail(`Preencha ${label}.`);
    const value = raw.trim();
    if (!value || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      fail(`Valor inválido em ${label}.`);
    }
    if (name !== 'Mensagem' && name !== 'Descricao' && /[\r\n]/.test(value)) {
      fail(`Valor inválido em ${label}.`);
    }
    clean[name] = value;
  }

  if (!isEmail(clean.Email)) fail('Informe um e-mail válido.');
  if (kind === 'quotation') {
    if (![10, 11].includes(clean.Telefone.replace(/\D/g, '').length)) fail('Informe um telefone válido.');
    if (!documentIsValid(clean.remetente) || !documentIsValid(clean.destinatario)) {
      fail('Informe CPF/CNPJ válido para remetente e destinatário.');
    }
  }
  return { kind, fields: clean };
};

const emailContent = (submission) => {
  const { kind, fields } = submission;
  const subject = kind === 'contact'
    ? `Contato pelo site: ${fields.subject}`
    : 'Nova cotação pelo site';
  const text = [
    kind === 'contact' ? 'Mensagem enviada pelo formulário de contato da TWT.' : 'Cotação enviada pelo site da TWT.',
    '',
    ...FIELDS[kind].map(([name, label]) => `${label}: ${fields[name]}`)
  ].join('\n');
  return {
    from: { name: 'Site TWT Airpack', address: SITE_EMAIL },
    to: SITE_EMAIL,
    replyTo: fields.Email,
    subject,
    text
  };
};

const smtpConfig = (env = process.env) => {
  const user = String(env.ZOHO_SMTP_USER || '').trim();
  const password = String(env.ZOHO_SMTP_PASSWORD || '').trim();
  const host = String(env.ZOHO_SMTP_HOST || 'smtppro.zoho.com').trim();
  const port = Number(env.ZOHO_SMTP_PORT || 465);
  if (!user || !password || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail('Envio de e-mail do site não configurado.', 503);
  }
  return {
    host,
    port,
    secure: String(env.ZOHO_SMTP_SECURE ?? (port === 465)).toLowerCase() !== 'false',
    auth: { user, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { servername: host }
  };
};

const sendSubmission = async (submission, env = process.env, createTransport) => {
  const transportFactory = createTransport || require('nodemailer').createTransport;
  const transport = transportFactory(smtpConfig(env));
  await transport.sendMail(emailContent(submission));
};

const localRateLimit = (key, now = Date.now()) => {
  const current = localLimits.get(key);
  const next = !current || current.expiresAt <= now
    ? { count: 1, expiresAt: now + RATE_WINDOW_SECONDS * 1_000 }
    : { count: current.count + 1, expiresAt: current.expiresAt };
  localLimits.set(key, next);
  if (localLimits.size > 10_000) {
    for (const [address, entry] of localLimits) {
      if (entry.expiresAt <= now) localLimits.delete(address);
    }
    if (localLimits.size > 10_000) localLimits.delete(localLimits.keys().next().value);
  }
  return next.count <= MAX_SENDS_PER_HOUR;
};

const allowSubmission = async (address, env = process.env, fetcher = fetch) => {
  const url = String(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '').replace(/\/$/, '');
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '');
  const key = `public-form:${require('node:crypto').createHash('sha256').update(address).digest('hex')}`;
  if (!url || !token) return localRateLimit(key);

  const response = await fetcher(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['INCR', key], ['EXPIRE', key, RATE_WINDOW_SECONDS]]),
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) fail('Envio indisponível no momento.', 503);
  const results = await response.json();
  const count = Number(results?.[0]?.result);
  if (!Number.isInteger(count) || results?.[0]?.error || results?.[1]?.error) {
    fail('Envio indisponível no momento.', 503);
  }
  return count <= MAX_SENDS_PER_HOUR;
};

module.exports = {
  MAX_BODY_BYTES,
  validateSubmission,
  emailContent,
  smtpConfig,
  sendSubmission,
  allowSubmission,
  localRateLimit
};
