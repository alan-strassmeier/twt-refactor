const MAX_BANK_BATCHES_PER_RUN = 20;

const bankFailureDiagnostics = (errors, batch) => errors.slice(0, 25).map((error) => {
  const invoiceId = String(error?.invoiceId || '');
  const bank = String(error?.bank || '');
  return {
    batch,
    invoiceId: /^[0-9]{1,20}$/.test(invoiceId) ? invoiceId : 'invalid',
    bank: bank === 'itau' || bank === 'bradesco' ? bank : 'unknown'
  };
});

const triggerBillingCollection = async (env, request = fetch) => {
  const endpoint = String(env.BILLING_ENDPOINT || '').trim();
  const secret = String(env.BILLING_CRON_SECRET || '');
  if (!endpoint.startsWith('https://') || secret.length < 32) {
    throw new Error('BILLING_ENDPOINT ou BILLING_CRON_SECRET não configurado.');
  }
  const call = async (route, extra = {}) => {
    const url = new URL(endpoint);
    url.searchParams.set('route', route);
    Object.entries(extra).forEach(([key, value]) => url.searchParams.set(key, String(value)));
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
    try {
      return await response.json();
    } catch {
      throw new Error(`A etapa ${route} respondeu HTTP ${response.status}, mas não retornou JSON válido.`);
    }
  };

  let lastCursor = '';
  const totals = { checked: 0, settled: 0, alreadySettled: 0, pending: 0 };
  for (let batch = 0; batch < MAX_BANK_BATCHES_PER_RUN; batch += 1) {
    const result = await call('bank-reconciliation-cron');
    if (!Array.isArray(result?.errors) || result.bankFailuresPersisted !== true ||
        typeof result?.hasMore !== 'boolean' ||
        Object.keys(totals).some((key) => !Number.isSafeInteger(result[key]) || result[key] < 0)) {
      throw new Error('A conciliação bancária retornou um formato inesperado; cobrança não iniciada.');
    }
    console.info('[twt-billing-cron:bank-batch]', {
      batch: batch + 1,
      checked: result.checked,
      settled: result.settled,
      alreadySettled: result.alreadySettled,
      pending: result.pending,
      errors: result.errors.length,
      hasMore: result.hasMore
    });
    if (result.errors.length) {
      // O retorno da Vercel pode conter mensagens de provedores externos. Elas
      // não vão aos logs; fatura e banco bastam para localizar a falha.
      bankFailureDiagnostics(result.errors, batch + 1).forEach((diagnostic) => {
        console.error('[twt-billing-cron:bank-error]', diagnostic);
      });
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
    const scheduledAt = new Date(controller.scheduledTime);
    if (!isSaoPauloWeekday(scheduledAt)) {
      console.info('[twt-billing-cron:skipped]', { scheduledAt: scheduledAt.toISOString(), reason: 'weekend' });
      return;
    }
    console.info('[twt-billing-cron:started]', { scheduledAt: scheduledAt.toISOString() });
    ctx.waitUntil(triggerBillingCollection(env).then((result) => {
      console.info('[twt-billing-cron:completed]', {
        scheduledAt: scheduledAt.toISOString(),
        scanned: Number(result?.scanned || 0),
        sent: Number(result?.sent || 0),
        errors: Array.isArray(result?.errors) ? result.errors.length : 0
      });
    }).catch((error) => {
      console.error('[twt-billing-cron:failed]', {
        scheduledAt: scheduledAt.toISOString(),
        message: String(error?.message || error).slice(0, 500)
      });
      throw error;
    }));
  },

  async fetch(request) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return Response.json({ service: 'twt-billing-cron', status: 'ok' });
  }
};

export { triggerBillingCollection, isSaoPauloWeekday, bankFailureDiagnostics };
