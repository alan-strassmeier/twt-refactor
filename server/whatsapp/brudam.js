const BASE_URL = (process.env.BRUDAM_API_URL || 'https://twt.brudam.com.br/api/v1').replace(/\/$/, '');
const TIMEOUT_MS = 20000;

let cachedToken = '';
let cachedTokenExpiresAt = 0;

const request = async (path, options = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { status: 0, message: await response.text() };
  return { response, payload };
};

const tokenExpiration = (token) => {
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - encoded.length % 4) % 4);
    return Number(JSON.parse(Buffer.from(encoded + padding, 'base64').toString('utf8')).exp) * 1000;
  } catch {
    return Date.now() + 240000;
  }
};

const authenticate = async (force = false) => {
  if (!force && cachedToken && Date.now() < cachedTokenExpiresAt - 30000) return cachedToken;
  const usuario = process.env.BRUDAM_API_USER || '';
  const senha = process.env.BRUDAM_API_PASSWORD || '';
  if (!/^[A-Fa-f0-9]{32}$/.test(usuario) || !/^[A-Fa-f0-9]{64}$/.test(senha)) {
    throw new Error('Credenciais Brudam não configuradas.');
  }
  const { response, payload } = await request('/acesso/auth/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  const token = payload?.data?.access_key;
  if (!response.ok || typeof token !== 'string' || !token) {
    throw new Error(`Falha no login Brudam: ${payload?.message || response.status}`);
  }
  cachedToken = token;
  cachedTokenExpiresAt = tokenExpiration(token);
  return token;
};

const authorizedRequest = async (path, options = {}) => {
  let token = await authenticate();
  let result = await request(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (result.response.status !== 401) return result;

  cachedToken = '';
  cachedTokenExpiresAt = 0;
  token = await authenticate(true);
  return request(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
};

const buildCostsQuery = (cteIdentifier) =>
  new URLSearchParams({ numero: cteIdentifier, limit: '2' }).toString();

const resolveMinutaAndClient = async (cteIdentifier) => {
  if (!/^\d+$/.test(cteIdentifier)) return null;
  let minutaIdentifier = cteIdentifier;

  if (cteIdentifier.length !== 44) {
    const query = buildCostsQuery(cteIdentifier);
    const { response, payload } = await authorizedRequest(`/operacional/custos?${query}`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok || Number(payload?.status) !== 1 || !Array.isArray(payload?.data)) {
      throw new Error(`Falha ao buscar minuta pelo CT-e: ${payload?.message || response.status}`);
    }
    const ids = [...new Set(payload.data
      .map((item) => Number(item?.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length !== 1) return null;
    minutaIdentifier = String(ids[0]);
  }

  const { response, payload } = await authorizedRequest(
    `/operacional/consulta/minuta/${encodeURIComponent(minutaIdentifier)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!response.ok || Number(payload?.status) !== 1 || !Array.isArray(payload?.data)) {
    throw new Error(`Falha ao consultar dados da minuta: ${payload?.message || response.status}`);
  }

  const matches = payload.data.flatMap((item) => {
    const minuta = Number(item?.minuta?.id);
    const clientCnpj = String(item?.toma?.nDoc || '').replace(/\D/g, '');
    return Number.isSafeInteger(minuta) && minuta > 0 && clientCnpj.length === 14
      ? [{ minuta, clientCnpj }]
      : [];
  });
  return matches.length === 1 ? matches[0] : null;
};

const completeReceiver = (proof) =>
  Boolean(proof.receiverName && proof.receiverDocument && proof.receiverRelationship);

const extensionFor = (mimeType) => {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
};

const createDeliveryOccurrence = async (input) => {
  const event = {
    codigo: 1,
    data: input.timestamp,
    obs: [
      `Baixa via WhatsApp por ${input.driverName} (${input.senderPhone}).`,
      `Código de barras ${input.barcode.text} (${input.barcode.format}).`,
      `Mensagem ${input.messageId}.`
    ].join(' ')
  };
  if (completeReceiver(input.proof)) {
    event.recebedor = {
      nome: input.proof.receiverName,
      documento: input.proof.receiverDocument,
      grau: input.proof.receiverRelationship
    };
  }
  if (input.location) event.localizacao = input.location;

  const body = {
    documentos: [{
      cliente: input.clientCnpj,
      tipo: 'MINUTA',
      minuta: input.minuta,
      eventos: [event],
      anexos: [{
        arquivo: {
          nome: `comprovante-${input.messageId.replace(/[^A-Za-z0-9._-]/g, '_')}.${extensionFor(input.mimeType)}`,
          dados: input.image.toString('base64')
        }
      }]
    }]
  };
  const { response, payload } = await authorizedRequest('/tracking/ocorrencias', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const documentsAccepted = !Array.isArray(payload?.data) ||
    payload.data.every((item) => Number(item?.status) === 1);
  if (!response.ok || Number(payload?.status) !== 1 || !documentsAccepted) {
    throw new Error(`Ocorrência recusada pela Brudam: ${JSON.stringify(payload)}`);
  }
  return payload;
};

module.exports = { buildCostsQuery, resolveMinutaAndClient, createDeliveryOccurrence };
