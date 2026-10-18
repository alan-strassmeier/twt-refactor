const MAX_BANK_BATCHES_PER_RUN = 20;

const triggerBillingCollection = async (env, request = fetch) => {
  const endpoint = String(env.BILLING_ENDPOINT || '').trim();
  const secret = String(env.BILLING_CRON_SECRET || '');
  if (!endpoint.startsWith('https://') || secret.length < 32) {
    throw new Error('BILLING_ENDPOINT ou BILLING_CRON_SECRET não configurado.');
  }
  const call = async (route, extra = {}) => {
    const url = new URL(endpoint);
    url.searchParams.set('route', route);
    Object.entries(extra).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await request(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${secret}`,
        'User-Agent': 'TWT-Billing-Cron/1.0'
      }
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(`A etapa ${route} respondeu HTTP ${response.status}: ${body}`);
    }
    return response.json();
  };

  let lastCursor = '';
  const totals = { checked: 0, settled: 0, alreadySettled: 0, pending: 0 };
  for (let batch = 0; batch < MAX_BANK_BATCHES_PER_RUN; batch += 1) {
    const result = await call('bank-reconciliation-cron');
    if (!Array.isArray(result?.errors) || typeof result?.hasMore !== 'boolean' ||
        Object.keys(totals).some((key) => !Number.isSafeInteger(result[key]) || result[key] < 0)) {
      throw new Error('A conciliação bancária retornou um formato inesperado; cobrança não iniciada.');
    }
    if (result.errors.length) {
      throw new Error(`${result.errors.length} boleto(s) com falha na conciliação; cobrança não iniciada.`);
    }
    Object.keys(totals).forEach((key) => { totals[key] += result[key]; });
    if (!result.hasMore) {
      return call('process', {
        bankReconciled: '1',
        bankChecked: String(totals.checked),
        bankSettled: String(totals.settled),
        bankAlreadySettled: String(totals.alreadySettled),
        bankPending: String(totals.pending)
      });
    }
    if (!/^\d{1,20}$/.test(String(result.nextCursor || '')) ||
        result.nextCursor === lastCursor || Number(result.checked) <= 0) {
      throw new Error('A fila de conciliação não avançou; cobrança não iniciada.');
    }
    lastCursor = result.nextCursor;
  }
  throw new Error('Conciliação bancária ainda em andamento; cobrança adiada para a próxima execução.');
};

const isSaoPauloWeekday = (date) => {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short'
  }).format(date);
  return weekday !== 'Sat' && weekday !== 'Sun';
};

export default {
  async scheduled(controller, env, ctx) {
    if (!isSaoPauloWeekday(new Date(controller.scheduledTime))) return;
    ctx.waitUntil(triggerBillingCollection(env));
  },

  async fetch(request) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return Response.json({ service: 'twt-billing-cron', status: 'ok' });
  }
};

export { triggerBillingCollection, isSaoPauloWeekday };
