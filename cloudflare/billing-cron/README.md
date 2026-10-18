# Agendamento da liquidação e cobrança

O plano Hobby da Vercel aceita cron apenas diário. Este Worker chama a função
consolidada da Vercel **de hora em hora, de segunda a sexta-feira**, no horário
de São Paulo. Não executa a rotina aos sábados e domingos. Na função, a
conciliação e eventual liquidação bancária terminam antes da busca e do envio
de faturas.

Em cada horário, o Worker chama `route=bank-reconciliation-cron` repetidamente
em lotes de até 25 boletos. O cursor fica no Redis para continuar na hora
seguinte se a lista exceder 20 lotes. Apenas depois de concluir a lista sem
erros ele chama `route=process&bankReconciled=1` para cobrar. Falha bancária,
resposta incompleta ou fila ainda não concluída adiam o envio de cobrança;
nenhum boleto é baixado sem confirmação do banco e da Brudam.

O Cloudflare interpreta expressões cron em UTC. Por isso, o `wrangler.jsonc`
usa `0 3-23 * * mon-fri` e `0 0-2 * * tue-sat`: juntas cobrem as 24 horas
dos dias úteis de São Paulo (UTC−3). O Worker também confere o dia da semana
em `America/Sao_Paulo` antes de chamar a Vercel, para impedir execuções no
fim de semana se a relação entre UTC e horário local mudar.

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
