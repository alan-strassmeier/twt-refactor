# Agendamento horário da cobrança

O plano Hobby da Vercel aceita cron apenas diário. Este Worker chama a função consolidada da Vercel no início de cada hora.

1. Troque `SEU-DOMINIO` em `wrangler.jsonc` pelo domínio de produção.
2. Na Vercel, crie `BILLING_CRON_SECRET` com um valor aleatório de pelo menos 32 caracteres.
3. Use exatamente o mesmo valor como segredo do Worker:

   ```powershell
   cd cloudflare\billing-cron
   npx wrangler secret put BILLING_CRON_SECRET
   ```

4. Publique o Worker:

   ```powershell
   npx wrangler deploy
   ```

O segredo nunca deve ser incluído no `wrangler.jsonc` ou enviado ao Git.
