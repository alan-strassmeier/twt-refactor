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

O deploy da Vercel **não publica este Worker**. Após cada alteração de código ou
agendamento em `cloudflare/billing-cron`, publique-o separadamente. Confirme no
painel da Cloudflare que os dois cron triggers estão ativos. Em um dia útil,
os logs devem mostrar `[twt-billing-cron:started]`, um ou mais
`[twt-billing-cron:bank-batch]` e, ao final, `completed` ou `failed`. Na
Vercel, procure `[faturamento:liquidacao:cron:lote]` e, quando a cobrança
iniciar, `[faturamento:cobranca:execucao]` com `source: automatic`. O endpoint
GET do Worker é apenas um teste de disponibilidade HTTP: `status: ok` não
confirma que o cron executou.

Ao editar variáveis no painel da Cloudflare, confira também a versão ativa e
os eventos agendados. Em 20/10/2026, a versão ativa continha apenas `fetch()`;
o cron disparava, mas todos os eventos falhavam com
`Handler does not export a scheduled() function`. Ter o gatilho e o segredo
configurados não basta se o código publicado não exportar `scheduled()`.

O segredo nunca deve ser incluído no `wrangler.jsonc` ou enviado ao Git.
