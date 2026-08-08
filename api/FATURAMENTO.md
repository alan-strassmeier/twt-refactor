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

C6_ENVIRONMENT=sandbox
C6_CLIENT_ID=
C6_CLIENT_SECRET=
C6_MTLS_CERT_BASE64=
C6_MTLS_KEY_BASE64=
C6_MTLS_KEY_PASSPHRASE=
C6_PARTNER_SOFTWARE_NAME=TWT Faturamento
C6_PARTNER_SOFTWARE_VERSION=1.0.0

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

`FATURAMENTO_SESSION_SECRET` deve ser um valor aleatório com pelo menos 32
caracteres. O Redis é utilizado para limitar tentativas de acesso de forma
consistente entre as funções serverless. Sem Redis, há uma proteção local por
instância.

Depois de cadastrar ou alterar as variáveis, faça um novo deployment.

## Boletos C6

A emissão bancária é exclusiva das faturas cujo emitente confirmado nos dados
da fatura/DOCCOB é a TWT (`09.123.137/0001-08`). Faturas DSL e faturas sem identificação segura
do emitente são recusadas no servidor, ainda que alguém tente chamar o endpoint
manualmente. Não existe parâmetro para selecionar outro banco: a integração usa
somente o C6.

O C6 exige OAuth2 `client_credentials` e autenticação mTLS. Cadastre-se no
[C6 Developers](https://developers.c6bank.com.br/create-access), solicite acesso
à API de Boleto e receba `client_id`, `client_secret`, certificado `.crt` e chave
`.key`. Converta os dois arquivos para Base64 antes de cadastrá-los na Vercel:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('caminho\certificado.crt'))
[Convert]::ToBase64String([IO.File]::ReadAllBytes('caminho\chave.key'))
```

Comece com `C6_ENVIRONMENT=sandbox`. O código seleciona automaticamente a
carteira 21 no sandbox e a carteira 15 em produção. Só altere para `production`
depois da homologação e da liberação das credenciais produtivas pelo C6.

O botão de boleto aparece no modal apenas para faturas TWT. A geração usa o
saldo pendente, o vencimento da fatura e os dados do pagador consultados em
`GET /cadastro/empresas`. O C6 exige razão social, CPF/CNPJ, logradouro, número,
cidade, UF e CEP; se algum desses dados estiver ausente, a emissão é bloqueada
com uma mensagem para correção do cadastro.

`POST /api/faturamento/boleto` gera ou recupera de forma idempotente o boleto da
fatura. `GET /api/faturamento/boleto-pdf?id=...` baixa o PDF diretamente do C6.
Ambos exigem a sessão administrativa. O POST também exige mesma origem.

O Redis é obrigatório para a emissão: ele mantém o vínculo entre a fatura e o
identificador do C6 e impede boletos duplicados em cliques simultâneos ou novas
execuções serverless. Uma falha de rede com resultado bancário incerto bloqueia
nova tentativa até conferência manual.

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
