# Área de faturamento

Página interna disponível em `/faturamento/`. A interface pública contém apenas
o formulário de acesso; os dados financeiros são consultados exclusivamente por
uma função protegida por sessão no servidor.

## Variáveis da Vercel

```env
FATURAMENTO_ADMIN_USER=admin
FATURAMENTO_ADMIN_PASSWORD=
FATURAMENTO_SESSION_SECRET=

BRUDAM_API_USER=
BRUDAM_API_PASSWORD=
BRUDAM_API_URL=https://twt.brudam.com.br/api/v1
# IDs internos do cadastro da Brudam, não os números físicos das contas
BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID=
BRUDAM_ITAU_BANK_ACCOUNT_ID=
BRUDAM_BRADESCO_BANK_ACCOUNT_ID=

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=twt-brudam-documentos
R2_DOCCOB_PREFIX=brudam/clientes
R2_DOCCOB_SCAN_LIMIT=250

BRADESCO_ENVIRONMENT=sandbox
BRADESCO_CLIENT_ID=
BRADESCO_CLIENT_SECRET=
# Opcional: se vazio, reutiliza NFSE_CERT_PFX_BASE64/NFSE_CERT_PASSWORD
BRADESCO_MTLS_PFX_BASE64=
BRADESCO_MTLS_PFX_PASSWORD=
# Compatibilidade com certificado e chave já separados em PEM
BRADESCO_MTLS_CERT_BASE64=
BRADESCO_MTLS_KEY_BASE64=
BRADESCO_MTLS_KEY_PASSPHRASE=
BRADESCO_BENEFICIARY_CNPJ=09123137000108
BRADESCO_BENEFICIARY_NAME=TWT AIRPACK SERVICOS AUX. DE TRANSP. AEREO LTDA
BRADESCO_AGENCY=7218
BRADESCO_AGENCY_DIGIT=4
BRADESCO_ACCOUNT=0000074
BRADESCO_ACCOUNT_DIGIT=4
BRADESCO_PRODUCT_ID=09
BRADESCO_BOLETO_SPECIES=4
BRADESCO_BOLETO_ACCEPTANCE=2
BRADESCO_PENALTY_PERCENT=3.00
BRADESCO_DAILY_INTEREST_PERCENT=0.15
BRADESCO_INTEREST_START_DAYS=2
BRADESCO_PENALTY_START_DAYS=2
# Opcional; usa o endpoint oficial do ambiente quando não informado
BRADESCO_SETTLED_LIST_URL=

ITAU_CLIENT_ID=
ITAU_CLIENT_SECRET=
ITAU_MTLS_CERT_BASE64=
ITAU_MTLS_KEY_BASE64=
ITAU_MTLS_KEY_PASSPHRASE=
ITAU_TOKEN_URL=https://sts.itau.com.br/api/oauth/token
ITAU_API_BASE_URL=https://api.gateway.itau.com.br/cash_management/v2
ITAU_QUERY_API_BASE_URL=https://boleto.api.itau.com/boleto/v1
ITAU_DETAIL_API_BASE_URL=https://secure.api.cloud.itau.com.br/boletoscash/v2
ITAU_API_KEY=
ITAU_BENEFICIARY_ID=
ITAU_BOLETO_WALLET=
ITAU_BOLETO_STAGE=validacao
ITAU_BOLETO_SKIP_PRECHECK=false
ITAU_RECONCILIATION_INVOICE_IDS=
ITAU_BOLETO_SPECIES=01
ITAU_BOLETO_ACCEPTANCE=N
ITAU_BENEFICIARY_NAME=DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA
ITAU_BENEFICIARY_CNPJ=97434690000129

NFSE_ENVIRONMENT=homologation
NFSE_CERT_MODE=a1
NFSE_API_BASE_URL=
NFSE_DPS_SERIES=
NFSE_DPS_INITIAL_NUMBER=0
NFSE_APPLICATION_VERSION=TWT_1.0.0
NFSE_REQUEST_TIMEOUT_MS=30000
NFSE_PROVIDER_PHONE=5133424425
NFSE_PROVIDER_EMAIL=faturamento@twt.com.br
NFSE_CERT_PFX_BASE64=
NFSE_CERT_PASSWORD=
# Legado A3; não é necessário no modo a1
NFSE_AGENT_TOKEN=
NFSE_AGENT_LEASE_MS=300000
R2_NFSE_PREFIX=nfse
R2_NFSE_ACCOUNT_ID=
R2_NFSE_ACCESS_KEY_ID=
R2_NFSE_SECRET_ACCESS_KEY=
R2_NFSE_BUCKET_NAME=twt-brudam-documentos

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

BILLING_BANK_RECONCILIATION_MAX_PER_RUN=8

ZOHO_SMTP_HOST=smtppro.zoho.com
ZOHO_SMTP_PORT=465
ZOHO_SMTP_SECURE=true
ZOHO_SMTP_USER=faturamento@twt.com.br
ZOHO_SMTP_PASSWORD=
ZOHO_SMTP_FROM_EMAIL=faturamento@twt.com.br
ZOHO_SMTP_FROM_NAME=TWT LOG
ZOHO_WEBHOOK_AUTH_KEY=
ZOHO_WEBHOOK_MAX_AGE_SECONDS=300
BILLING_ALERT_EMAIL=adrianoldepaula@gmail.com
BILLING_CRON_SECRET=
BILLING_EMAIL_MAX_INVOICES_PER_RUN=12
BILLING_EMAIL_SCAN_PAGES_PER_RUN=2
BILLING_EMAIL_DEADLINE_MS=50000
```

`FATURAMENTO_SESSION_SECRET` deve ser um valor aleatório com pelo menos 32
caracteres. O Redis é utilizado para limitar tentativas de acesso de forma
consistente entre as funções serverless. Sem Redis, há uma proteção local por
instância.

Depois de cadastrar ou alterar as variáveis, faça um novo deployment.

## Cobrança automática por e-mail

A aba **Cobrança de faturas** usa uma única função consolidada,
`/api/faturamento/cobranca`, para permanecer dentro do limite de funções do
plano Hobby. Nela é possível cadastrar e excluir empresas por CNPJ, cadastrar,
habilitar, desabilitar e excluir destinatários, consultar faturas aguardando
DOCCOB e filtrar logs por fatura, data e CNPJ.

Ao cadastrar uma empresa, o sistema consulta `GET /cadastro/empresas` da
Brudam pelo CNPJ e importa os contatos com e-mail existentes em `xGrupo`. O
botão **Atualizar Contatos** repete a consulta e inclui somente os e-mails que
ainda não estão na lista, inicialmente com o envio desabilitado, preservando
nomes e escolhas dos contatos que já existiam. O controle
**Envio ✔️ / Envio ❌** determina se cada contato recebe as cobranças; contatos
desabilitados permanecem cadastrados, mas não entram na fila de destinatários.

Ao excluir uma pessoa, o servidor consulta a versão mais recente da empresa,
envia ao `PATCH /cadastro/empresas` a lista `xGrupo` sem aquele e-mail e faz um
novo GET para confirmar a remoção. O registro local só é apagado depois dessa
confirmação, evitando divergência silenciosa entre a Brudam e o sistema de
cobrança. Os demais contatos e os campos documentados de cada item de `xGrupo`
são preservados na atualização.

A carga inicial contém somente os 107 contatos do arquivo LDIF do Zoho que
possuíam `categories`. Categorias múltiplas foram expandidas, totalizando 115
associações de contatos em 39 empresas. A carga é executada uma única vez no
Redis; exclusões feitas pela interface não são recriadas em deployments
posteriores. Para repetir deliberadamente a importação, remova no Redis as
chaves `faturamento:cobranca:categorias:v1` e
`faturamento:cobranca:categorias-seed:v1`.

Se o primeiro nome for deixado vazio ao cadastrar uma pessoa, o sistema o
deduz da parte anterior a `@`. Os separadores `.`, `-` e `_` dividem primeiro
nome e sobrenome. Por exemplo, `jon.doe@empresa.com` resulta em `Jon Doe`.

Para receber confirmação posterior de entrega, use um Agent do **Zoho
ZeptoMail**. Troque as credenciais SMTP pelas fornecidas na aba SMTP/API do
Agent (`smtp.zeptomail.com`, porta 465 com SSL ou 587 com TLS). A senha fica
somente em `ZOHO_SMTP_PASSWORD` na Vercel e nunca deve ser commitada. O sistema
envia o cabeçalho `X-TM-CLIENT-REF` para relacionar cada evento do ZeptoMail à
fatura e ao destinatário corretos.

Na aba **Webhooks** do mesmo Agent:

1. configure como URL
   `https://SEU-DOMINIO/api/faturamento/cobranca?route=webhook`;
2. marque os eventos **Delivered**, **Soft bounced** e **Hard bounced**;
3. crie uma chave de autenticação aleatória e forte no ZeptoMail;
4. cadastre exatamente o mesmo valor na Vercel como
   `ZOHO_WEBHOOK_AUTH_KEY` e faça um novo deployment;
5. use **Send Test** no ZeptoMail. A resposta esperada da URL é HTTP 200.

Se a tela atual do ZeptoMail exibir **Authorization headers**, use uma destas
opções (a primeira é recomendada):

- nome `X-TWT-Webhook-Token` e valor igual a `ZOHO_WEBHOOK_AUTH_KEY`; ou
- nome `Authorization` e valor `Bearer VALOR_DE_ZOHO_WEBHOOK_AUTH_KEY`.

`ZOHO_WEBHOOK_AUTH_KEY` é o nome da variável na Vercel, não o nome recomendado
para o cabeçalho HTTP. O nome legado também é aceito pelo servidor para não
bloquear configurações já salvas.

O endpoint é público porque precisa receber chamadas do ZeptoMail. O POST
rejeita payloads que não tenham a assinatura HMAC-SHA256 oficial válida nem um
dos tokens configurados acima. GET e HEAD apenas retornam o estado `ready` para
verificadores de disponibilidade e nunca processam eventos. A URL faz parte da
função consolidada e não consome uma Serverless Function adicional.

O log **Aguardando confirmação** significa apenas que o SMTP aceitou a
mensagem. **Entregue ao servidor destinatário** significa que o servidor do
destinatário a aceitou. Isso ainda não comprova a colocação na caixa de entrada:
spam e quarentena são decisões posteriores do provedor do destinatário. Bounces
temporários e definitivos aparecem no mesmo registro do envio, e o motivo
enviado pelo ZeptoMail fica disponível ao passar o mouse sobre o status.

O botão **Visualizar** dos logs abre uma cópia textual do e-mail com remetente,
destinatário, assunto, prioridade, mensagem e nomes dos anexos. Os PDFs não são
duplicados no Redis. Registros anteriores à implantação deste recurso não têm
essa cópia e são identificados como conteúdo indisponível.

Em cada execução o servidor:

1. consulta primeiro as faturas em aberto emitidas nas últimas 72 horas
   (incluindo o dia da borda, pois a Brudam filtra emissão apenas por data);
2. envia o aviso inicial somente quando consegue montar o PDF da fatura e, para
   pagamentos que não sejam TED/DOC, anexar também o boleto. Para faturas DSL,
   reúne e anexa em um único PDF todos os DACTEs vinculados no DOCCOB;
3. em seguida percorre as faturas em aberto e envia **Perto do vencimento**
   quando faltam até dois dias, com prioridade alta;
4. nessa mesma lista, envia aviso de vencida a partir de dois dias após o
   vencimento, com prioridade alta. No primeiro dia após o vencimento não há
   envio automático de aviso vencido;
5. envia uma mensagem separada para `BILLING_ALERT_EMAIL` nos avisos próximos
   do vencimento e vencidos, sem incluir o endereço em cópia nas mensagens dos
   clientes.

Para faturas emitidas antes de **16/09/2026**, a rotina não executa envio
inicial histórico. Essas faturas só retornam à fila automática quando entram
no período de aviso **Perto do vencimento** ou quando passam a ser **Vencidas**.
O reenvio manual continua disponível e mantém suas validações próprias.

O nome antigo `BILLING_ALERT_COPY` continua aceito para não interromper
ambientes que já o configuraram, mas `BILLING_ALERT_EMAIL` é o nome recomendado.
O endereço legado `adriano@twt.com.br` é migrado automaticamente para
`adrianoldepaula@gmail.com` durante esta transição.

Cada combinação de evento, fatura e destinatário é reservada no Redis antes do
envio. Atualizar a página ou executar a rotina novamente não envia uma segunda
cópia. Falhas comprovadamente anteriores ao aceite do SMTP liberam somente a
reserva daquela tentativa e mantêm a fatura na fila para nova verificação; o log
indica **Não enviado — nova tentativa pendente** e mostra a etapa e o erro.
Timeouts durante a transmissão e falhas ao registrar um aceite continuam como
**Requer conferência**, sem repetição automática que possa duplicar a cobrança.
**Marcar resolvido** encerra apenas o alerta; não reenvia nem libera uma reserva.
Registros antigos de conferência não são liberados automaticamente após a
atualização, pois não é possível provar retroativamente se o SMTP os aceitou.

O botão **Verificar agora** e as quatro rotinas automáticas consultam primeiro
as emissões recentes e depois todas as faturas em aberto, em páginas com
cursores separados no Redis. A primeira página é revisitada em cada rodada
para captar novas faturas; as páginas seguintes avançam nas execuções
posteriores. Itens descobertos que excedem o limite de processamento ficam
registrados na fila. A rotina não percorre a Central de pendências; na
varredura geral só entram na fila faturas elegíveis para aviso de vencimento.

O botão **Atualizar** da Central de pendências possui um fluxo separado. Para
cada item visível ele consulta primeiro a situação financeira atual na Brudam.
Se a fatura estiver liquidada, cancelada ou sem saldo, remove o registro
operacional e oculta a falha antiga correspondente sem procurar DOCCOB, gerar
boleto ou enviar e-mail. Somente faturas ainda abertas seguem para a
revalidação de DOCCOB, contatos, documentos e envio. A atualização usa lotes e
intervalos entre consultas para respeitar o limite da API da Brudam.

O plano Hobby da Vercel não executa vários crons diários. O diretório
`cloudflare/billing-cron` contém um Worker da Cloudflare configurado para chamar
a rotina **de hora em hora, de segunda a sexta-feira**, no horário de São Paulo.
Os crons do Cloudflare estão expressos em UTC como `0 3-23 * * mon-fri` e
`0 0-2 * * tue-sat`, com uma verificação adicional do dia local no Worker.
Cada disparo faz primeiro a conciliação completa dos boletos em lotes de até
25 via `route=bank-reconciliation-cron`. O cursor persiste no Redis entre
horários; se houver falhas ou a lista exceder 20 lotes, a cobrança é adiada
até uma execução completar a conferência. Só então o Worker chama
`route=process&bankReconciled=1`, passando os totais da conferência para o
resumo da execução sem repetir as consultas bancárias.
Troque o domínio em
`wrangler.jsonc` somente se o domínio de produção deixar de ser `www.twt.com.br`.
Configure na Vercel um `BILLING_CRON_SECRET` aleatório com pelo menos 32 caracteres e
cadastre exatamente o mesmo valor no Worker:

```powershell
cd cloudflare\billing-cron
npx wrangler secret put BILLING_CRON_SECRET
npx wrangler deploy
```

O botão **Verificar agora** usa a sessão administrativa e executa o mesmo fluxo
sem depender do agendamento. Quando a fila ultrapassa o limite seguro de uma
função da Vercel, o navegador continua automaticamente em novos lotes. Somente
a primeira rodada consulta emissões recentes e faturas abertas na Brudam; as continuações tratam
apenas os registros **Aguardando processamento** descobertos pela mesma
execução, sem absorver pendências antigas de DOCCOB, contato ou pagamento.

### Conciliação bancária e liquidação na Brudam

No agendamento, o Worker termina a varredura de todos os boletos registrados
no Redis que ainda não possuem conciliação concluída antes de iniciar a
cobrança. A rota `bank-reconciliation-cron` exige o segredo do agendador,
mantém um cursor próprio no Redis e usa a mesma validação do botão de
liquidação. Em uma verificação manual de cobrança, a conciliação limitada
também termina antes da leitura da fila. Cada fatura é reconfirmada na
Brudam imediatamente antes de qualquer baixa.

A conciliação limitada da rota geral `route=process`, quando chamada sem a
conferência prévia do Worker (por exemplo, por **Verificar agora**), mantém
a restrição Itaú: sem
`ITAU_RECONCILIATION_INVOICE_IDS`, nenhum boleto Itaú novo é liquidado. Para
testar apenas as faturas separadas, configure `11817,11838`; depois de
homologar os resultados, `*` libera todas as faturas Itaú registradas. A
conferência de uma tentativa anterior com status `submission_pending` continua
ativa mesmo fora da lista, mas nunca repete o POST na Brudam. A varredura
completa do Worker, tal como o botão **Liquidar faturas**, não usa essa lista:
inclui todos os boletos Itaú e Bradesco prontos, com as mesmas validações de
pagamento, saldo e idempotência.

No Itaú, a conciliação usa `GET /boletoscash/v2/boletos` com beneficiário,
carteira e Nosso Número do boleto registrado. Confere ainda CPF/CNPJ do
pagador, valor original e, quando armazenados, vencimento e Seu Número. Somente
um título identificado de forma inequívoca, com situação paga/liquidada e
lançamentos em `pagamentos_cobranca` que cubram integralmente o valor nominal,
fica elegível. Pagamentos parciais, respostas ambíguas ou dados divergentes
bloqueiam a baixa. `data_pagamento` recebe a última data de
`data_inclusao_pagamento` dos lançamentos confirmados pelo Itaú, enquanto o
valor recebido vem da soma desses lançamentos. A data precisa estar entre a
emissão do boleto e a conferência. O registro guarda as origens
`itau_v2_payment_inclusion` e `itau_v2_payments` para auditoria. A listagem v1 permanece
em uso apenas na conferência preventiva e recuperação de emissão de boletos.

No Bradesco, a rotina usa `POST /boleto/cobranca-lista/v1/listar`, recurso
**Cobrança - Listar boletos liquidados**. Como a documentação informa dados
D-1 e permite até 60 dias, cada execução consulta os pagamentos dos 60 dias
anteriores e cruza Nosso Número, valor original do título e, quando informado,
CPF/CNPJ do pagador com o registro persistido. Números repetidos em registros
distintos ou listagens incompletas bloqueiam a baixa automática. Baixas e
cancelamentos não são interpretados como pagamentos.

Quando o banco confirma o recebimento, o servidor consulta novamente a fatura.
Se ela já estiver liquidada, apenas encerra a conciliação. Se estiver aberta e
o valor cobrir o saldo, envia `POST /financeiro/liquidar/lancamento`, usando a
data da confirmação Bradesco ou da inclusão do pagamento Itaú em `data_pagamento` e
`data_credito_debito` e eventual excedente bancário como `valor_juros`.
Para o Bradesco, `valor_liquidado` recebe o total efetivamente pago; para o
Itaú, permanece o saldo nominal da fatura. No Itaú, saldo diferente do valor nominal
impede a baixa automática. Depois remove a
pendência de cobrança e marca os três eventos de e-mail como concluídos.
Um lock por fatura impede duas execuções simultâneas de enviar a mesma baixa.
Antes do POST na Brudam, a tentativa fica gravada no Redis. Em caso de timeout
ou resposta incerta, a rotina não repete o POST: confirma novamente o status
na Brudam e exige conferência manual enquanto a fatura continuar aberta.

`BRUDAM_BANK_SLIP_PAYMENT_METHOD_ID`, `BRUDAM_ITAU_BANK_ACCOUNT_ID` e
`BRUDAM_BRADESCO_BANK_ACCOUNT_ID` devem receber os IDs internos retornados ou
exibidos pela Brudam. Não utilize `ITAU_BENEFICIARY_ID`, `BRADESCO_ACCOUNT` ou
o número bancário visível como substitutos. Sem esses IDs, a consulta bancária
continua possível, mas a baixa é recusada com diagnóstico de configuração.

Administradores autenticados podem validar exclusivamente a permissão de
consulta com `GET /api/faturamento/cobranca?route=bank-diagnostic`. A rota usa
`GET /boletos` no Itaú e a listagem de títulos liquidados de D-1 no Bradesco,
retornando somente o sucesso, a quantidade de registros e o estado de
configuração dos IDs da Brudam. Se a resposta Itaú tiver formato inesperado,
o diagnóstico inclui apenas status HTTP, host, tipo de conteúdo e nomes dos
campos estruturais da resposta, nunca os dados dos boletos. Ela não emite
boleto, não liquida fatura, não envia e-mail e não grava estado no Redis.
A listagem Itaú aceita os campos de paginação `page` (coleção oficial) ou
`pagination` (observado em produção). Quando `totalElements` e `pageSize`
estão presentes, aceita `totalPages` tanto como quantidade de páginas quanto
como índice da última página (zero para uma página), desde que a contagem de
registros feche. Rejeita metadados ausentes ou inconsistentes para não
confundir erro com ausência de boletos.

Na área **Liquidar Faturas**, o botão **Liquidar faturas** inicia uma varredura
manual dos boletos prontos registrados no Redis, ainda não conciliados. A rota
autenticada `POST /api/faturamento/cobranca?route=bank-reconciliation-batch`
recebe `{"afterInvoiceId":""}` e devolve lotes de até oito faturas, com
`hasMore` e `nextCursor`. A interface continua a paginação até o fim (ou
oferece **Continuar liquidação** após cem lotes), sem mover o cursor do
agendador nem acionar o envio de cobranças. A varredura manual inclui os
boletos Itaú independentemente da lista temporária
`ITAU_RECONCILIATION_INVOICE_IDS`; isso não altera a restrição do agendador.
Cada baixa ainda exige pagamento integral confirmado pelo banco, identidade
do boleto e fatura aberta com saldo compatível na Brudam. A consulta
Bradesco permanece na janela D-1 documentada pelo banco. O servidor exige
sessão administrativa, mesma origem e trava contra outra execução financeira.
Tentativas de baixa com resultado incerto nunca são repetidas automaticamente.

A seção **Liquidar boleto** aceita número de fatura com boleto
Itaú ou Bradesco. `GET /api/faturamento/cobranca?route=bank-reconciliation-preview&id=11838`
consulta o banco correspondente e a fatura atual na Brudam, mas não grava no
Redis nem chama `POST /financeiro/liquidar/lancamento`. Após uma prévia apta,
**Liquidar este boleto** chama
`POST /api/faturamento/cobranca?route=bank-reconciliation-invoice` com
`{"invoiceId":"11838"}`. Exige sessão administrativa e mesma origem. A
execução refaz as conferências e usa os mesmos locks e controles de
idempotência da rotina automática. Não percorre outras faturas nem envia
cobranças. As rotas antigas `itau-reconciliation-preview` e
`itau-reconciliation-run` permanecem para compatibilidade e preservam a
restrição por lista explícita do Itaú.

### Recuperação pontual da fatura 11838

A tentativa antiga da 11838 ficou em `submission_pending` sem resposta
persistida, quando a conta Itaú estava configurada com o número físico
`16666` em vez do ID interno Brudam `6`. A liberação dessa fatura exige
sessão administrativa, mesma origem e botão **Liberar tentativa manual**.
A rota `POST /api/faturamento/cobranca?route=itau-reconciliation-rearm`
aceita somente `{"invoiceId":"11838"}` e, antes de gravar qualquer mudança,
reconfere o pagamento no Itaú, o lançamento aberto e saldo integral na
Brudam, o mesmo ID interno de lançamento e o ID bancário `6`. O estado
permanece `submission_pending` para que as versões já implantadas e o
agendador continuem sem repetir o POST. A autorização é única e fica
registrada no histórico do boleto; somente o botão manual **Liquidar esta
fatura** pode consumi-la, após nova prévia e novas consultas. A liberação
em si nunca envia uma baixa financeira.

### Histórico de liquidações

`GET /api/faturamento/cobranca?route=liquidation-log` exige sessão e retorna
as 100 liquidações mais recentes feitas pelo sistema, sem executar conciliação
nem alterar a Brudam. As baixas Itaú e Bradesco confirmadas vêm dos
registros de boleto no Redis; registros `already_settled` (baixas já existentes
na Brudam) não aparecem no histórico. Aprovações de planilhas White Martins são registradas em
uma lista persistente no Redis a partir desta versão, somente após resposta
de sucesso da Brudam. A falha ao escrever o histórico não transforma uma
baixa já aceita em erro que induza novo envio. Importações antigas expiradas
não podem ser reconstruídas por esse histórico.

## Roteamento dos boletos

O banco é definido no servidor pelo emitente confirmado nos dados da
fatura/DOCCOB. Não existe parâmetro no navegador para selecionar ou trocar o
banco:

- TWT (`09.123.137/0001-08`) gera boleto convencional exclusivamente no Bradesco;
- DSL (`97.434.690/0001-29`) gera boleto exclusivamente no Itaú;
- faturas sem identificação segura do emitente são recusadas.

Essa validação também ocorre no endpoint de geração. Assim, uma chamada manual
jamais envia uma fatura DSL ao Bradesco nem uma fatura TWT ao Itaú.

## Boletos Bradesco (TWT)

O Bradesco exige OAuth2 `client_credentials` e autenticação mTLS tanto na
obtenção do token quanto nas chamadas da API. O sistema aceita diretamente o
mesmo A1 (`.pfx`/`.p12`) usado pela NFS-e. Se as variáveis mTLS específicas do
Bradesco estiverem vazias, reutiliza automaticamente `NFSE_CERT_PFX_BASE64` e
`NFSE_CERT_PASSWORD`. Para manter credenciais bancárias independentes, repita o
PFX em `BRADESCO_MTLS_PFX_BASE64` e a senha em
`BRADESCO_MTLS_PFX_PASSWORD`.

O certificado público associado à aplicação no portal Bradesco deve pertencer
ao mesmo PFX usado pela Vercel. Ele pode ser exportado sem a chave privada pelo
PowerShell:

```powershell
$pfxPath = 'C:\caminho\certificado-twt.pfx'
$pfxPassword = Read-Host 'Senha do PFX' -AsSecureString
$flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
$cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxPath, $pfxPassword, $flags)
[IO.File]::WriteAllBytes('C:\caminho\bradesco-twt-publico.cer', $cert.Export('Cert'))
```

Envie ao portal somente `bradesco-twt-publico.cer`; nunca envie o PFX nem a
senha. As credenciais `BRADESCO_CLIENT_ID` e `BRADESCO_CLIENT_SECRET` precisam
ter sido geradas para esse mesmo certificado.

Comece com `BRADESCO_ENVIRONMENT=sandbox`. O sistema usa os endpoints oficiais
`openapisandbox.prebanco.com.br` nesse ambiente e troca para
`openapi.bradesco.com.br` somente quando a variável for alterada para
`production`. Certificado e credenciais de sandbox não devem ser reutilizados em
produção.

Antes da produção, a conta precisa ter contrato de cobrança ativo, indicador
`175` habilitado e ao menos um acesso anterior ao Bradesco Net Empresa. No
sandbox, o portal aceita certificado A1 público autoassinado; em produção, use o
certificado A1 público emitido por uma autoridade certificadora confiável e as
credenciais produtivas liberadas pelo banco. A chave privada correspondente fica
somente dentro do PFX na Vercel e nunca deve ser enviada ao portal ou
versionada. O formato separado em PEM continua aceito por compatibilidade por
meio de `BRADESCO_MTLS_CERT_BASE64`, `BRADESCO_MTLS_KEY_BASE64` e, quando
necessário, `BRADESCO_MTLS_KEY_PASSPHRASE`.

O botão identifica o Bradesco para faturas TWT. A geração usa o
saldo pendente, o vencimento da fatura e os dados do pagador consultados em
`GET /cadastro/empresas`. O Bradesco exige razão social, CPF/CNPJ, logradouro,
número, bairro, cidade, UF e CEP; se algum desses dados estiver ausente, a
emissão é bloqueada com uma mensagem para correção do cadastro. Logradouro,
bairro e município são enviados sem acentos e sem caracteres especiais, como
determina o layout.

`POST /api/faturamento/boleto` gera ou recupera de forma idempotente o boleto da
fatura. `GET /api/faturamento/boleto-pdf?id=...` gera localmente o recibo do
pagador e a ficha de compensação Bradesco ou Itaú com os dados bancários
autorizados. Ambos exigem a sessão administrativa. O POST também exige mesma
origem.

O Redis é obrigatório para a emissão: ele mantém o vínculo entre a fatura e o
Nosso Número devolvido pelo Bradesco e impede boletos duplicados em cliques
simultâneos ou novas execuções serverless. Como o Nosso Número é gerado pelo
banco, não existe uma consulta preventiva antes do primeiro registro. Após a
emissão, a consulta de título específico usa esse Nosso Número para recuperar a
segunda via. Uma falha de rede sem Nosso Número e com resultado bancário incerto
bloqueia nova tentativa até conferência manual no Bradesco Net Empresa.

O número da negociação de registro é montado automaticamente como agência de 4
dígitos + 7 zeros + conta de 7 dígitos. Para consulta, é usado agência + conta,
totalizando 11 dígitos. A carteira/produto padrão é `09`, a espécie `4` representa
`DS` e o aceite `2` representa não aceite. O sistema envia Nosso Número `0` para
que o Bradesco gere o identificador.

Os encargos confirmados para a TWT são multa de 3% e juros de 0,15% ao dia. Como
o campo de juros da API é mensal e o Bradesco calcula o valor diário dividindo
por 30, o payload envia 4,50% ao mês. Ambos começam após o vencimento com o
deslocamento documentado pelo banco: para iniciar no dia seguinte, os campos
`qtdeDiasJuros` e `qtdeDiasMulta` recebem `2`, pois a API subtrai um dia do valor
informado.

## Boletos Itaú (DSL)

O sistema reconhece o CNPJ da DSL e apresenta o Itaú como banco obrigatório. A
fatura DSL nunca é enviada ao Bradesco. A implementação segue a especificação oficial
`API Boletos - Emissão e Instrução 2.75.147`: autenticação OAuth2/mTLS no STS e
emissão em `POST /cash_management/v2/boletos`. A resposta fornece `id_boleto`,
nosso número, linha digitável e código de barras. Como essa API não oferece uma
rota de PDF, o servidor gera localmente o recibo do pagador e a ficha de
compensação a partir dos dados retornados pelo Itaú.

Na integração produtiva, o recurso do boleto é enviado dentro do envelope
`{"data": { ... }}` exigido pelo gateway Itaú. Os campos de beneficiário,
pagador e título permanecem dentro desse objeto `data`.
O valor do título é transmitido em 17 posições numéricas, com os dois últimos
dígitos representando os centavos, e `desconto_expresso` é enviado
explicitamente como `false` quando esse produto não é utilizado.

O cliente renova o token de acesso e envia automaticamente certificado, chave
privada, `x-itau-apikey`, correlation ID e flow ID. A listagem da API Boletos
v1 (`GET /boleto/v1/boletos`) serve à conferência preventiva de emissão; a
API BoletosCash v2 (`GET /boletoscash/v2/boletos`) fornece os pagamentos para
conciliação. São APIs distintas da rota usada para emitir boletos.

Converta o certificado e a chave privada para Base64 antes de cadastrá-los na
Vercel. Execute em PowerShell, fora do repositório:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\TWT\Itau-DSL\itau-dsl.crt'))
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\TWT\Itau-DSL\itau-dsl.key'))
```

Use a primeira saída em `ITAU_MTLS_CERT_BASE64` e a segunda em
`ITAU_MTLS_KEY_BASE64`. `ITAU_CLIENT_ID` é a credencial fornecida na planilha e
`ITAU_CLIENT_SECRET` é o conteúdo de `itau-client-secret.txt`. Como o Itaú usa o
próprio client ID em `x-itau-apikey` neste fluxo, `ITAU_API_KEY` pode permanecer
vazia; preencha-a somente se o contrato fornecer uma chave distinta.

`ITAU_BENEFICIARY_ID` contém exatamente 12 dígitos: agência (4), conta (7) e DAC
(1). `ITAU_BOLETO_WALLET` contém os 3 dígitos da carteira contratada. Confirme
esses dois valores com o Itaú; eles não podem ser deduzidos do certificado.

Mantenha `ITAU_BOLETO_STAGE=validacao` no primeiro deployment. Nesse modo o Itaú
valida o mesmo payload usado na produção, a interface informa o sucesso e nenhum
título é registrado ou salvo como boleto emitido. Depois de homologar os dados,
altere somente para `ITAU_BOLETO_STAGE=efetivacao`. Em efetivação, o Redis reserva
a fatura antes do POST e mantém o vínculo com o `id_boleto`, impedindo emissão
duplicada. Respostas incertas ficam bloqueadas para conferência manual.

Enquanto a credencial do Itaú ainda não possuir acesso ao `GET /boletos`, uma
fatura nova pode ser usada em teste com `ITAU_BOLETO_SKIP_PRECHECK=true`. Essa
opção pula somente a consulta preventiva anterior ao primeiro POST. Ela não
libera faturas já marcadas como `review`, pois nelas houve uma tentativa com
resultado bancário incerto e repetir a emissão poderia criar uma duplicidade.
Volte a variável para `false` assim que o Itaú liberar a consulta.

Se a efetivação retornar linha digitável e código de barras sem `id_boleto`, o
identificador é formado conforme o contrato Itaú: beneficiário (12) + carteira
(3) + nosso número (8 a 16). Uma fatura marcada para revisão é consultada por
esses mesmos dados antes de qualquer nova emissão; a consulta nunca repete o
POST do boleto.

Os padrões iniciais são espécie `01` e aceite `N`. Se o contrato da carteira DSL
determinar outros códigos, altere `ITAU_BOLETO_SPECIES` e
`ITAU_BOLETO_ACCEPTANCE` antes da efetivação. Nome e CNPJ do beneficiário têm os
valores da DSL como padrão e podem ser sobrescritos pelas variáveis indicadas.

## NFS-e Nacional (TWT)

A emissão de NFS-e está disponível somente para faturas cujo emitente confirmado
no DOCCOB seja a TWT (`09.123.137/0001-08`). A competência é sempre a data de
emissão da própria fatura. Antes de transmitir, a interface apresenta CNPJ e
razão social do tomador, competência, valor, código do serviço e descrição para
confirmação humana.

O padrão fiscal confirmado para a TWT é aplicado no servidor: serviço nacional
`15.06.03`, NBS `106081000`, prestação e incidência em Porto Alegre, Simples
Nacional, ISSQN não retido, PIS/COFINS CST `00` e percentual aproximado de
tributos de `5,97%`. O navegador não pode alterar esses campos.

Use uma série de DPS exclusivamente reservada para esta integração. Não reutilize
a série `70000` do exemplo emitido manualmente no Portal Nacional. Defina em
`NFSE_DPS_INITIAL_NUMBER` o último número já utilizado na nova série; o Redis
reserva o próximo número de maneira atômica e mantém o vínculo com a fatura para
evitar emissões duplicadas.

O fluxo oficial usa `NFSE_CERT_MODE=a1`: a própria função da Vercel assina a DPS
e faz a conexão mTLS, sem aplicativo da certificadora ou agente local. Converta o
arquivo A1 completo (`.pfx` ou `.p12`) para Base64 e cadastre o resultado em
`NFSE_CERT_PFX_BASE64`; em `NFSE_CERT_PASSWORD`, use a senha que abre o arquivo:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('caminho\certificado-twt.pfx'))
```

Cadastre as três variáveis no mesmo ambiente da Vercel usado pelo domínio
(`Production`, para `www.twt.com.br`) e faça um novo deploy. Alterar uma variável
não modifica deployments que já estavam publicados. Depois de validar o A1, o
agente A3 pode permanecer fechado. Solicitações antigas ainda na fila do agente
são consultadas e retomadas pelo A1 com o mesmo número de DPS; uma concessão A3
ainda ativa precisa expirar antes da retomada, evitando transmissão duplicada.

O modo `agent` permanece apenas para compatibilidade com o fluxo A3 anterior. Se
for necessário reativá-lo, configure `NFSE_AGENT_TOKEN` com pelo menos 32
caracteres e siga `nfse-a3-agent/`.

Mantenha `NFSE_ENVIRONMENT=homologation` durante a validação. O ambiente de
produção só deve ser ativado depois dos testes, da definição da série exclusiva
e da confirmação das permissões do certificado. A URL oficial é escolhida pelo
ambiente; `NFSE_API_BASE_URL` normalmente permanece vazia.

Os registros, filas, sequenciais e XMLs são isolados por ambiente. Assim, uma
fatura testada em homologação pode ser emitida posteriormente em produção sem
reaproveitar o documento de teste. O DANFSe de homologação exibe claramente
`SEM VALOR FISCAL` e seu QR code aponta para a Consulta Pública de Produção
Restrita. Para a emissão fiscal definitiva, configure na Vercel
`NFSE_ENVIRONMENT=production`, mantenha `NFSE_API_BASE_URL` vazio e faça um novo
deploy antes de solicitar a emissão.

O token usado em `R2_NFSE_*` precisa da permissão `Object Read & Write` e deve
ser limitado ao bucket escolhido. Recomenda-se criar um token separado do token
somente leitura usado para os DOCCOBs. Se nenhuma variável dedicada for
preenchida, a aplicação reutiliza `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` e `R2_BUCKET_NAME`; nesse caso, esse token geral também
precisará de escrita.

`POST /api/faturamento/nfse` cria a emissão. No modo A1, a própria função assina
e transmite; no modo A3, ela enfileira a DPS e a interface acompanha o agente.
`GET/POST /api/faturamento/nfse-agent` é exclusivo do executável e exige o bearer
token. Se o agente perder uma concessão após uma possível transmissão, o próximo
processamento consulta a DPS pelo identificador em vez de reenviá-la. O XML
autorizado é preservado no R2 sob
`<R2_NFSE_PREFIX>/<ambiente>/<ano>/<fatura>/<chave>.xml` e o estado fica no Redis. Por isso,
Redis e R2 são obrigatórios para emitir.

`GET /api/faturamento/nfse-pdf?id=...` gera o DANFSe a partir do XML autorizado e
`GET /api/faturamento/nfse-xml?id=...` entrega o XML original. Ambos exigem a
sessão administrativa.

## Consulta

O servidor aceita os filtros documentados de data de emissão e vencimento,
status, CNPJ e número da fatura (`id[eq]` na consulta da Brudam). `limit` é limitado a 100 registros e `skip` é usado
na paginação.

O status **Vencidas** é calculado pela aplicação e não existe na Brudam. Ao
selecioná-lo, o servidor consulta faturas em aberto (`status=0`) com vencimento
até o dia anterior à busca, considerando o fuso horário de São Paulo. Se o
usuário informar um vencimento final anterior, o período mais restritivo é
preservado.

A documentação da Brudam define `valor`, mas não documenta data de pagamento,
valor pago ou saldo. Quando esses campos adicionais estiverem presentes no
retorno, a aplicação os utiliza. Caso não estejam, uma fatura liquidada é
considerada integralmente paga; nas demais situações, o valor pago começa em
zero e o saldo é calculado pelo valor total.

Quando o retorno de faturas contém apenas `cnpj_cliente`, o servidor consulta
`GET /cadastro/empresas?cnpj=...` e usa o campo `fantasia` para preencher o
nome do cliente. Os CNPJs são deduplicados e os nomes usam cache temporário.

Nas consultas por CNPJ sem número de fatura, o servidor percorre todas as
páginas retornadas pela Brudam, mantém apenas o CNPJ solicitado e ordena o
resultado completo pela emissão mais recente. A consulta consolidada usa cache
temporário de cinco minutos.

### Gráfico de saldos pendentes

O seletor `Lista / Gráfico` reutiliza exatamente os filtros preenchidos no
formulário. No modo gráfico, a interface acrescenta `view=debtors` à requisição.
O servidor percorre as páginas da consulta, mantém somente faturas com saldo
positivo que não estejam liquidadas ou canceladas, enriquece os nomes pelo
cadastro de empresas e agrupa os valores por CNPJ.

Como o gráfico representa somente valores em aberto, a consulta consolidada
solicita `status=0` à Brudam quando o filtro de status estiver em `Todos`. As
páginas são carregadas em pequenos lotes paralelos para consultas de períodos
longos não ultrapassarem o tempo da função serverless.

O retorno contém `totalPending`, `invoiceCount`, `companyCount` e `debtors`.
Cada item de `debtors` informa nome, CNPJ, saldo, percentual do total e número
de faturas pendentes. O resumo consolidado usa cache temporário de cinco
minutos para reduzir chamadas repetidas à Brudam.

O gráfico também apresenta o saldo e a quantidade de faturas nas faixas **A
vencer**, **1–7**, **8–15**, **16–30**, **31–60** e **Mais de 60 dias**. As
faixas são calculadas pela data corrente em São Paulo e o cache é separado por
dia para não preservar uma classificação anterior após a meia-noite.

Ao passar o ponteiro, focar ou clicar em uma divisão do gráfico, a empresa
correspondente é destacada na legenda. O clique mantém a seleção até outra
divisão ser escolhida ou o usuário clicar fora do gráfico; a legenda rola
automaticamente quando a empresa estiver fora da área visível. Cada empresa da
legenda também funciona como atalho: ao acioná-la, a interface preenche o CNPJ,
mantém os demais filtros e abre a lista de faturas em aberto daquela empresa.

Na lista de faturas, a coluna **Prazo** calcula a diferença entre o vencimento
e a data atual em São Paulo. Ela diferencia faturas vencidas, que vencem hoje,
que vencem amanhã e as que ainda possuem prazo maior, sem marcar faturas
liquidadas ou canceladas como atrasadas.

## Importação de pagamentos White Martins

A importação aceita uma planilha `.xlsx` de até 2 MB e restringe a busca às
empresas marcadas como **White Martins** no cadastro de cobrança. A coluna
**Referência** identifica o CT-e, **Montante em MI** informa o valor pago e
**Vencimento** representa a data efetiva do pagamento.

A data da coluna **Vencimento** é usada em `data_pagamento` e
`data_credito_debito` ao liquidar a fatura na Brudam. Ela não é comparada com o
vencimento cadastrado na fatura ou no DOCCOB, pois são informações com
significados diferentes. Quando uma mesma fatura possui vários CT-es, todas as
linhas precisam informar a mesma data de pagamento.

Antes da aprovação, o servidor ainda exige que a fatura esteja aberta, que o
CNPJ corresponda ao DOCCOB, que todas as referências estejam presentes e que o
valor importado seja igual ao saldo atual. A aprovação pode ser individual ou
em lote; nenhuma baixa acontece apenas com o envio da planilha.

Na liquidação TED/DOC da conta ITAU-DSL, `forma_pagamento` recebe o ID interno
Brudam `16` e `conta_bancaria` recebe o ID interno `6`, não o número da conta
`16666` exibido no PDF. Importações já analisadas antes dessas correções também
usam os IDs internos atuais no momento da aprovação.

## PDF da fatura

A coluna `Visualizar` abre `GET /api/faturamento/fatura-pdf?id=...` em uma nova
guia. O endpoint exige a mesma sessão autenticada da área de faturamento e nunca
expõe o token da Brudam no navegador.

Como a API pública da Brudam não documenta um endpoint de PDF completo, o
servidor gera a página principal da fatura em A4. A parte bancária e o boleto
não são gerados.

### DOCCOB no Cloudflare R2

Crie no Cloudflare R2 um token S3 com a permissão `Object Read only`, limitado
ao bucket `twt-brudam-documentos`. Cadastre na Vercel o Account ID, o Access Key
ID e o Secret Access Key nas variáveis acima. O segredo deve existir somente na
Vercel e nunca deve ser enviado ao navegador ou commitado.

O caminho esperado dos arquivos é:

```text
brudam/clientes/<CNPJ sem máscara>/doccob/*.txt
```

Ao abrir uma fatura, o servidor localiza nesse diretório o DOCCOB cujo conteúdo
possui o número exato da fatura. A identificação das remessas segue esta ordem:

1. chave CT-e válida de 44 dígitos;
2. número da minuta informado pelo vínculo `FT_CTR` quando não existe chave;
3. NF + CNPJ informado no registro `CTR_NF`.

Na terceira tentativa, resultados da Brudam são conferidos contra a NF e o CNPJ
antes de serem aceitos. Resultados ambíguos não são escolhidos por aproximação.
Várias notas que apontem para a mesma minuta são deduplicadas.

Se o R2 ainda não estiver configurado ou o DOCCOB não for encontrado, permanece
o fluxo anterior baseado nos vínculos eventualmente retornados pela API de
faturas. `R2_DOCCOB_SCAN_LIMIT` limita quantos arquivos recentes do cliente são
examinados em uma chamada e pode ser aumentado gradualmente se necessário.
