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

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

`FATURAMENTO_SESSION_SECRET` deve ser um valor aleatório com pelo menos 32
caracteres. O Redis é utilizado para limitar tentativas de acesso de forma
consistente entre as funções serverless. Sem Redis, há uma proteção local por
instância.

Depois de cadastrar ou alterar as variáveis, faça um novo deployment.

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
