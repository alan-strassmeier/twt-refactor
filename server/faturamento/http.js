const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.end(JSON.stringify(payload));
};

const parseJsonBody = async (req, maxBytes = 4096) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > maxBytes) throw Object.assign(new Error('Payload muito grande.'), { statusCode: 413 });
    return JSON.parse(req.body);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Payload muito grande.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const requestOrigin = (req) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
};

const hasSameOrigin = (req) => {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const expected = requestOrigin(req).replace(/\/$/, '');
  return Boolean(origin && expected && origin === expected);
};

const clientAddress = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
};

const queryFromRequest = (req) => {
  const requestUrl = String(req.url || '/');
  if (requestUrl.length > 8192) {
    throw Object.assign(new Error('URL de consulta muito grande.'), { statusCode: 414 });
  }
  const url = new URL(requestUrl, requestOrigin(req) || 'https://internal.invalid');
  const query = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  return query;
};

module.exports = {
  sendJson,
  parseJsonBody,
  hasSameOrigin,
  clientAddress,
  queryFromRequest
};
