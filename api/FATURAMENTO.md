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
