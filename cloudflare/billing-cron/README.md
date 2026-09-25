# Agendamento diário da cobrança

O plano Hobby da Vercel aceita cron apenas diário. Este Worker chama a função
consolidada da Vercel quatro vezes por dia: **07:00, 12:00, 16:00 e 22:00**, no
horário de São Paulo.

O Cloudflare interpreta expressões cron em UTC. Por isso, o `wrangler.jsonc`
usa `0 1,10,15,19 * * *`, equivalente a 22:00, 07:00, 12:00 e 16:00 em
São Paulo (UTC−3).

1. Na Vercel, crie `BILLING_CRON_SECRET` com um valor aleatório de pelo menos 32 caracteres.
2. Use exatamente o mesmo valor como segredo do Worker:

   ```powershell
   cd cloudflare\billing-cron
   npx wrangler secret put BILLING_CRON_SECRET
   ```

3. Publique o Worker:

   ```powershell
   npx wrangler deploy
   ```

O segredo nunca deve ser incluído no `wrangler.jsonc` ou enviado ao Git.
