# Formulários públicos (Contato e Cotação)

Os dois formulários de `index.html` enviam `POST /api/public-form` no mesmo
domínio do site. A função envia uma mensagem de texto pelo SMTP do Zoho,
usando `twt@twt.com.br` no campo **De** e como destinatário. O e-mail do
visitante fica em `Reply-To`, para facilitar a resposta.

Os formulários reutilizam as mesmas variáveis SMTP já usadas pelo faturamento
na Vercel. Não é necessária uma segunda senha:

```text
ZOHO_SMTP_USER=<conta Zoho com permissão de enviar como twt@twt.com.br>
ZOHO_SMTP_PASSWORD=<senha de aplicativo dessa conta>
ZOHO_SMTP_HOST=smtppro.zoho.com
ZOHO_SMTP_PORT=465
ZOHO_SMTP_SECURE=true
```

`HOST`, `PORT` e `SECURE` usam os mesmos padrões do faturamento. A conta em
`ZOHO_SMTP_USER` autentica ambos os fluxos. Como `twt@twt.com.br` é uma lista,
confirme no Zoho que essa conta recebeu a permissão **Send as Group** para
enviar com esse endereço no campo De; acesso para receber mensagens da lista
não garante essa permissão. Nunca coloque a senha no HTML, JavaScript público
ou Git.

O endpoint aceita apenas JSON de mesma origem, valida os campos no servidor,
ignora destinatários enviados pelo navegador e limita cada IP a cinco
tentativas; o contador reinicia após uma hora sem novas tentativas. Se `UPSTASH_REDIS_REST_URL` e
`UPSTASH_REDIS_REST_TOKEN` estiverem configurados, o limite é compartilhado
entre instâncias da Vercel. Sem Redis, o limite é local a cada instância e
oferece apenas proteção básica. Há também um campo-armadilha contra bots.

Depois do deploy, teste Contato e Cotação com dados seus e confira o
recebimento em `twt@twt.com.br`, inclusive a pasta de spam. Um HTTP 200
confirma que o Zoho aceitou o envio, não a entrega final na caixa de entrada.
