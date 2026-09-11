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
WHATSAPP_EXAMPLE_IMAGE_URL           # opcional; padrão no domínio www.twt.com.br
WHATSAPP_RECEIVER_FLOW_ID            # ID do Flow publicado para os dados do recebedor
WHATSAPP_DELIVERY_TIME_FLOW_ID       # ID do Flow publicado para data e horário da entrega
BRUDAM_API_USER
BRUDAM_API_PASSWORD
BRUDAM_API_URL                      # opcional
APP_TIMEZONE                        # padrão: America/Sao_Paulo
```

## Redis obrigatório

O Redis impede que uma repetição do webhook gere a mesma ocorrência duas vezes. Os dados temporários da tentativa de baixa (estado da conversa, localização, data/hora manual e comprovante aguardando o recebedor) expiram após 15 minutos de inatividade.

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
5. O motorista recebe uma saudação pelo horário e escolhe entre iniciar a baixa ou falar com um atendente.
6. Ao iniciar a baixa, o motorista informa se a entrega foi realizada naquele momento.
7. Se responder **Sim**, o horário continua sendo obtido da mensagem da foto. Se responder **Não**, recebe um Flow para selecionar data, hora e minuto.
8. O calendário bloqueia dias futuros e o servidor rejeita também um horário futuro no dia atual.
9. Depois da confirmação do horário, recebe a imagem de exemplo e o sistema passa a aguardar a foto do comprovante.
10. Na legenda da imagem, o motorista é orientado a enviar `cancelar` caso queira abandonar a tentativa; o comando limpa os dados temporários e retorna ao menu inicial.
11. Cada etapa ativa expira após 15 minutos de inatividade. Uma nova interação após o vencimento começa novamente pelo menu.
12. Após identificar o CT-e, o motorista recebe o Flow do recebedor e preenche nome, documento e grau/relação. Os três campos são obrigatórios.
13. A Brudam resolve dinamicamente minuta e CNPJ do tomador pelo CT-e.
14. A ocorrência `codigo: 1` é enviada com foto, motorista, data/horário escolhido, localização e dados do recebedor.
15. Os `messageId` da foto e das respostas ficam marcados como concluídos por 90 dias.

## Flow de data e horário

O WhatsApp Flows não possui um componente único de seleção de horário. O Flow usa um `DatePicker` para a data e dois seletores para hora e minuto, permitindo informar o minuto exato.

1. No WhatsApp Manager, crie um Flow **sem endpoint**.
2. Use um nome como `Data e horário da entrega`.
3. Substitua o JSON inicial pelo conteúdo de `docs/whatsapp-flow-data-hora.json`.
4. Execute a validação do editor e publique o Flow.
5. Copie o ID publicado para `WHATSAPP_DELIVERY_TIME_FLOW_ID` na Vercel.
6. Faça um novo deploy.

A aplicação envia a data atual para `max_date` sempre que abre o Flow. A validação no servidor continua obrigatória porque o limite visual do calendário não impede, sozinho, que se selecione no dia atual uma hora posterior à atual.

Nunca coloque segredos em arquivos versionados ou no código do navegador.

## Execução no servidor próprio

O adaptador da Vercel permanece compatível e continua usando Redis quando
`WHATSAPP_STATE_STORE` não é informado. A alternativa com webhook HTTP
persistente, fila durável e estado no PostgreSQL está documentada em
`services/whatsapp-baixa/README.md`.

No servidor próprio, os comprovantes são mantidos em armazenamento privado por
30 dias e removidos automaticamente. Na Vercel, `WHATSAPP_IMAGE_STORE` continua
com o padrão `none`, portanto esse arquivamento não é feito pelo adaptador
antigo.

Ela deve ser implantada primeiro com `WHATSAPP_DRY_RUN=true`, allowlist de
telefones de teste e sem trocar o callback de produção até que healthchecks,
fila e logs tenham sido validados. A migração SQL não é executada
automaticamente ao iniciar o container.
