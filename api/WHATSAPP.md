# Webhook WhatsApp → Brudam

A função `api/whatsapp.mjs` recebe mensagens da Meta e responde à verificação do webhook. Fotos são processadas após o HTTP 200 com `waitUntil`.

## URL do callback

```text
https://SEU-DOMINIO/api/whatsapp
```

Use na Meta o mesmo valor cadastrado como `WHATSAPP_VERIFY_TOKEN` na Vercel e assine o campo `messages`.

## Variáveis obrigatórias na Vercel

```text
WHATSAPP_VERIFY_TOKEN
WHATSAPP_APP_SECRET
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_GRAPH_VERSION              # exemplo: v25.0
WHATSAPP_SEND_REPLIES               # true ou false
BRUDAM_API_USER
BRUDAM_API_PASSWORD
BRUDAM_API_URL                      # opcional
APP_TIMEZONE                        # padrão: America/Sao_Paulo
```

## Redis obrigatório

O Redis impede que uma repetição do webhook gere a mesma ocorrência duas vezes, mantém a localização e guarda por 30 minutos o comprovante que aguarda os dados digitados do recebedor.

No projeto da Vercel, abra **Storage/Marketplace**, conecte uma instância **Upstash Redis** e confirme a criação destas variáveis:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Também são aceitos os nomes antigos `KV_REST_API_URL` e `KV_REST_API_TOKEN`. Habilite as variáveis para Production e Preview, depois faça um novo deploy.

## Fluxo seguro

1. A assinatura `X-Hub-Signature-256` é validada com `WHATSAPP_APP_SECRET`.
2. A função responde `200` imediatamente e continua com `waitUntil`.
3. O `messageId` é reservado atomicamente no Redis.
4. A foto é baixada e o código de barras é lido localmente.
5. O motorista responde `NOME | DOCUMENTO | GRAU/RELAÇÃO` ou `PULAR`.
6. A Brudam resolve dinamicamente minuta e CNPJ do tomador pelo CT-e.
7. A ocorrência `codigo: 1` é enviada com foto, motorista, horário, localização e os dados digitados quando informados.
8. Os `messageId` da foto e da resposta ficam marcados como concluídos por 90 dias.

Nunca coloque segredos em arquivos versionados ou no código do navegador.
