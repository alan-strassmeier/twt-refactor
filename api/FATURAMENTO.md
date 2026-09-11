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

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=twt-brudam-documentos
R2_DOCCOB_PREFIX=brudam/clientes
R2_DOCCOB_SCAN_LIMIT=250

BRADESCO_ENVIRONMENT=sandbox
BRADESCO_CLIENT_ID=
BRADESCO_CLIENT_SECRET=
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

ITAU_CLIENT_ID=
ITAU_CLIENT_SECRET=
ITAU_MTLS_CERT_BASE64=
ITAU_MTLS_KEY_BASE64=
ITAU_MTLS_KEY_PASSPHRASE=
ITAU_TOKEN_URL=https://sts.itau.com.br/api/oauth/token
ITAU_API_BASE_URL=https://api.gateway.itau.com.br/cash_management/v2
ITAU_API_KEY=
ITAU_BENEFICIARY_ID=
ITAU_BOLETO_WALLET=
ITAU_BOLETO_STAGE=validacao
ITAU_BOLETO_SKIP_PRECHECK=false
ITAU_BOLETO_SPECIES=01
ITAU_BOLETO_ACCEPTANCE=N
ITAU_BENEFICIARY_NAME=DSL DO BRASIL TRANSPORTE E LOGISTICA LTDA
ITAU_BENEFICIARY_CNPJ=97434690000129

NFSE_ENVIRONMENT=homologation
NFSE_CERT_MODE=agent
NFSE_API_BASE_URL=
NFSE_DPS_SERIES=
NFSE_DPS_INITIAL_NUMBER=0
NFSE_APPLICATION_VERSION=TWT_1.0.0
NFSE_REQUEST_TIMEOUT_MS=30000
NFSE_PROVIDER_PHONE=5133424425
NFSE_PROVIDER_EMAIL=faturamento@twt.com.br
NFSE_CERT_PFX_BASE64=
NFSE_CERT_PASSWORD=
NFSE_AGENT_TOKEN=
NFSE_AGENT_LEASE_MS=300000
R2_NFSE_PREFIX=nfse
R2_NFSE_ACCOUNT_ID=
R2_NFSE_ACCESS_KEY_ID=
R2_NFSE_SECRET_ACCESS_KEY=
R2_NFSE_BUCKET_NAME=twt-brudam-documentos

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

ZOHO_SMTP_HOST=smtppro.zoho.com
ZOHO_SMTP_PORT=465
ZOHO_SMTP_SECURE=true
ZOHO_SMTP_USER=faturamento@twt.com.br
ZOHO_SMTP_PASSWORD=
ZOHO_SMTP_FROM_EMAIL=faturamento@twt.com.br
ZOHO_SMTP_FROM_NAME=TWT LOG
BILLING_ALERT_COPY=adriano@twt.com.br
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
plano Hobby. Nela é possível cadastrar e excluir empresas por CNPJ, cadastrar e
excluir destinatários, consultar faturas aguardando DOCCOB e filtrar logs por
fatura, data e CNPJ.

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

Use no Zoho uma senha específica de aplicativo quando a conta tiver
autenticação em dois fatores. A senha fica somente em `ZOHO_SMTP_PASSWORD` na
Vercel e nunca deve ser commitada. O log **Aceito pelo Zoho** significa que o
servidor SMTP aceitou a mensagem para entrega; SMTP não confirma, sozinho, que
a caixa do destinatário a recebeu ou abriu.

Em cada execução o servidor:

1. consulta faturas em aberto emitidas no dia e reprocessa as que aguardavam
   DOCCOB;
2. envia o aviso inicial somente quando consegue montar o PDF da fatura e, para
   pagamentos que não sejam TED/DOC, anexar também o boleto. Para faturas DSL,
   reúne e anexa em um único PDF todos os DACTEs vinculados no DOCCOB;
3. consulta as faturas em aberto com vencimento dois dias depois e envia o
   aviso **Perto do vencimento**;
4. consulta faturas vencidas ainda em aberto e envia o aviso de vencida;
5. copia `BILLING_ALERT_COPY` nos avisos próximos do vencimento e vencidos.

Cada combinação de evento, fatura e destinatário é reservada no Redis antes do
envio. Atualizar a página ou executar a rotina novamente não envia uma segunda
cópia. Em caso de resposta SMTP incerta, o registro fica como **Requer
conferência**, sem tentativa automática que possa duplicar a cobrança.

O plano Hobby da Vercel não executa cron a cada hora. O diretório
`cloudflare/billing-cron` contém um Worker da Cloudflare configurado para chamar
a rotina no início de cada hora. Troque o domínio em `wrangler.jsonc`, configure
na Vercel um `BILLING_CRON_SECRET` aleatório com pelo menos 32 caracteres e
cadastre exatamente o mesmo valor no Worker:

```powershell
cd cloudflare\billing-cron
npx wrangler secret put BILLING_CRON_SECRET
npx wrangler deploy
```

O botão **Verificar agora** usa a sessão administrativa e executa o mesmo fluxo
sem depender do agendamento.

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
obtenção do token quanto nas chamadas da API. Converta o certificado público e
a chave privada para Base64 antes de cadastrá-los na Vercel:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('caminho\certificado.crt'))
[Convert]::ToBase64String([IO.File]::ReadAllBytes('caminho\chave.key'))
```

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
somente na Vercel, em Base64, e nunca deve ser enviada ao portal ou versionada.
Se a chave estiver criptografada, configure também
`BRADESCO_MTLS_KEY_PASSPHRASE`.

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

O cliente renova o token de acesso, envia automaticamente certificado, chave
privada, `x-itau-apikey`, correlation ID e flow ID. A consulta documentada em
`GET /cash_management/v2/boletos` também está implementada para conferência por
beneficiário, carteira, nosso número e data de inclusão.

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

Para o certificado A3 físico, use `NFSE_CERT_MODE=agent` e configure
`NFSE_AGENT_TOKEN` com pelo menos 32 caracteres aleatórios. O executável Windows,
as instruções de instalação e o autoteste ficam em `nfse-a3-agent/`. O agente
consulta a fila por HTTPS, assina dentro do token e faz também a conexão mTLS com
o Ambiente Nacional. O PIN nunca é recebido pela Vercel.

Para gerar um token compatível também com versões antigas do Windows PowerShell:

```powershell
$bytes = New-Object byte[] 48
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[Convert]::ToBase64String($bytes)
```

Como alternativa futura, `NFSE_CERT_MODE=a1` mantém a emissão direta na Vercel.
Nesse modo, o certificado A1 deve ser convertido integralmente para Base64 e
cadastrado em `NFSE_CERT_PFX_BASE64`, com a senha em `NFSE_CERT_PASSWORD`:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('caminho\certificado-twt.pfx'))
```

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
