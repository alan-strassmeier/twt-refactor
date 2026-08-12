const https = require('node:https');
const { gzipSync, gunzipSync } = require('node:zlib');

const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const XML_MAX_BYTES = 2 * 1024 * 1024;

const endpointUrl = (config, path) =>
  new URL(String(path || '').replace(/^\/+/, ''), `${config.baseUrl}/`).toString();

const httpsRequest = ({ url, method = 'GET', headers = {}, body = null, config }) =>
  new Promise((resolve, reject) => {
    const payload = body === null || body === undefined
      ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    const request = https.request(new URL(url), {
      method,
      pfx: config.pfx,
      passphrase: config.passphrase || undefined,
      minVersion: 'TLSv1.2',
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': String(payload.length) } : {})
      }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_MAX_BYTES) {
          request.destroy(Object.assign(new Error('Resposta da NFS-e excedeu o limite permitido.'), {
            statusCode: 502,
            receivedResponse: true,
            ambiguousNfseState: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300
          }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        statusCode: Number(response.statusCode) || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.setTimeout(config.requestTimeoutMs, () => {
      request.destroy(Object.assign(new Error('Tempo esgotado ao acessar a NFS-e Nacional.'), {
        statusCode: 504,
        ambiguousNfseState: method === 'POST'
      }));
    });
    request.on('error', (error) => {
      if (!error.statusCode) error.statusCode = 502;
      if (method === 'POST' && error.receivedResponse !== true) error.ambiguousNfseState = true;
      reject(error);
    });
    if (payload) request.write(payload);
    request.end();
  });

const parseJsonResponse = (result) => {
  try {
    return JSON.parse(result.body.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('A NFS-e Nacional retornou uma resposta inválida.'), {
      statusCode: 502,
      receivedResponse: true,
      upstreamStatus: result.statusCode
    });
  }
};

const responseMessages = (payload) => {
  const entries = [
    payload?.mensagem,
    payload?.message,
    payload?.detail,
    ...(Array.isArray(payload?.erros) ? payload.erros : []),
    ...(Array.isArray(payload?.errors) ? payload.errors : [])
  ];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const code = entry.codigo || entry.code || '';
    const description = entry.descricao || entry.mensagem || entry.message || entry.detail || '';
    return description ? [`${code ? `${code}: ` : ''}${description}`] : [];
  }).map((message) => String(message).replace(/[\r\n]+/g, ' ').slice(0, 500));
};

const upstreamError = (result, payload, fallback) => {
  const messages = responseMessages(payload);
  return Object.assign(new Error(messages[0] || fallback), {
    statusCode: result.statusCode === 429 ? 503 : 422,
    upstreamStatus: result.statusCode,
    upstreamMessages: messages,
    receivedResponse: true,
    expose: true
  });
};

const decodeAuthorizedXml = (payload) => {
  const encoded = String(
    payload?.nfseXmlGZipB64 ||
    payload?.NFSeXmlGZipB64 ||
    payload?.xmlGZipB64 ||
    ''
  ).replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Object.assign(new Error('A NFS-e Nacional não retornou o XML autorizado.'), {
      statusCode: 502,
      receivedResponse: true
    });
  }
  let xml;
  try {
    xml = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: XML_MAX_BYTES })
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trim();
  } catch {
    throw Object.assign(new Error('O XML autorizado retornado pela NFS-e está corrompido.'), {
      statusCode: 502,
      receivedResponse: true
    });
  }
  if (!/^<\?xml[^>]*>\s*<(?:\w+:)?NFSe\b|^<(?:\w+:)?NFSe\b/i.test(xml) ||
      /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw Object.assign(new Error('Conteúdo inesperado no XML autorizado da NFS-e.'), {
      statusCode: 502,
      receivedResponse: true
    });
  }
  return xml;
};

const postDps = async (signedXml, options = {}) => {
  const config = options.config;
  const request = options.request || httpsRequest;
  const payload = JSON.stringify({
    dpsXmlGZipB64: gzipSync(Buffer.from(signedXml, 'utf8')).toString('base64')
  });
  const result = await request({
    url: endpointUrl(config, '/nfse'),
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: payload,
    config
  });
  const response = parseJsonResponse(result);
  if (result.statusCode !== 201 && result.statusCode !== 200) {
    const error = upstreamError(result, response, 'A DPS foi recusada pela NFS-e Nacional.');
    if (result.statusCode === 408 || result.statusCode >= 500) {
      error.ambiguousNfseState = true;
    }
    throw error;
  }
  try {
    return { ...response, xml: decodeAuthorizedXml(response) };
  } catch (error) {
    error.ambiguousNfseState = true;
    throw error;
  }
};

const getDps = async (dpsId, options = {}) => {
  const config = options.config;
  const request = options.request || httpsRequest;
  const result = await request({
    url: endpointUrl(config, `/dps/${encodeURIComponent(dpsId)}`),
    headers: { Accept: 'application/json' },
    config
  });
  const response = parseJsonResponse(result);
  if (result.statusCode === 404) return null;
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw upstreamError(result, response, 'Não foi possível consultar a DPS na NFS-e Nacional.');
  }
  return { ...response, xml: decodeAuthorizedXml(response) };
};

module.exports = {
  RESPONSE_MAX_BYTES,
  XML_MAX_BYTES,
  endpointUrl,
  httpsRequest,
  parseJsonResponse,
  responseMessages,
  decodeAuthorizedXml,
  postDps,
  getDps
};
