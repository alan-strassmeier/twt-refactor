const triggerBillingCollection = async (env) => {
  const endpoint = String(env.BILLING_ENDPOINT || '').trim();
  const secret = String(env.BILLING_CRON_SECRET || '');
  if (!endpoint.startsWith('https://') || secret.length < 32) {
    throw new Error('BILLING_ENDPOINT ou BILLING_CRON_SECRET não configurado.');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${secret}`,
      'User-Agent': 'TWT-Billing-Cron/1.0'
    }
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`A rotina de cobrança respondeu HTTP ${response.status}: ${body}`);
  }
  return response.json();
};

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(triggerBillingCollection(env));
  },

  async fetch(request) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return Response.json({ service: 'twt-billing-cron', status: 'ok' });
  }
};

export { triggerBillingCollection };
