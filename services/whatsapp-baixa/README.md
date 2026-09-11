# Baixa de entrega pelo WhatsApp no servidor próprio

Este serviço recebe o webhook da Meta, persiste cada evento antes de responder
`200`, processa a fila no PostgreSQL e mantém os comprovantes em armazenamento
privado por 30 dias. Ele é independente do adaptador da Vercel em
`api/whatsapp.mjs`.

## Componentes de produção

- aplicação: `whatsapp-baixa`, definida em `compose.whatsapp.yaml`;
- banco: PostgreSQL interno na rede Docker `twt_backend`;
- entrada pública: Cloudflare Tunnel `twt-cloudflared-whatsapp`;
- segredo: `/opt/twt/secrets/whatsapp-baixa.env`, fora do Git e com modo `600`;
- imagens: `/opt/twt/data/whatsapp-baixa`, fora do Git e com modo `700`;
- inicialização: `twt-whatsapp-stack.service`.

Não publique portas do PostgreSQL ou do Docker. O callback público deve apontar
somente para `/api/whatsapp` por HTTPS.

## Preparação

1. Crie o usuário e o banco da aplicação no PostgreSQL.
2. Crie `/opt/twt/secrets/whatsapp-baixa.env` a partir de
   `environment.example`, sem copiar valores reais para o repositório.
3. Crie `/opt/twt/data/whatsapp-baixa` e permita escrita apenas ao usuário do
   container.
4. Confirme que `twt-postgres`, a rede `twt_backend` e o container do túnel já
   existem.
5. Faça um backup do PostgreSQL antes de aplicar novas migrações.

As variáveis exigidas estão listadas, somente pelos nomes, em
`environment.example`. Em uma implantação inicial mantenha:

```text
WHATSAPP_DRY_RUN=true
WHATSAPP_ENFORCE_ALLOWLIST=true
WHATSAPP_ALLOW_ALL_SENDERS=false
```

## Build, migração e teste sem envio real

Na raiz do repositório:

```bash
docker compose -f compose.whatsapp.yaml build whatsapp-baixa whatsapp-migrate
docker compose -f compose.whatsapp.yaml --profile tools run --rm whatsapp-migrate
docker compose -f compose.whatsapp.yaml up -d whatsapp-baixa
docker compose -f compose.whatsapp.yaml ps
docker compose -f compose.whatsapp.yaml logs --tail 100 whatsapp-baixa
```

Valide os endpoints pela rede interna. `live` confirma o processo e `ready`
confirma também o acesso ao PostgreSQL:

```bash
app_container="$(docker compose -f compose.whatsapp.yaml ps -q whatsapp-baixa)"
docker exec "$app_container" \
  node -e "fetch('http://127.0.0.1:3000/health/live').then(async r=>{console.log(r.status,await r.text())})"
docker exec "$app_container" \
  node -e "fetch('http://127.0.0.1:3000/health/ready').then(async r=>{console.log(r.status,await r.text())})"
```

## Inicialização automática

Os arquivos versionados ficam em `deploy/whatsapp`. O instalador preserva os
arquivos anteriores em `/var/backups/twt-whatsapp-autostart`, valida a unidade e
habilita o serviço no boot:

```bash
sudo ./deploy/whatsapp/install-autostart.sh
```

O serviço espera o PostgreSQL ficar saudável, reconcilia a aplicação pelo
Compose e inicia o túnel. Uma falha é repetida pelo `systemd` após 15 segundos.

Validação:

```bash
systemctl is-enabled twt-whatsapp-stack.service
systemctl is-active twt-whatsapp-stack.service
journalctl -u twt-whatsapp-stack.service -n 100 --no-pager
docker inspect twt-postgres --format '{{.State.Health.Status}}'
docker compose -f compose.whatsapp.yaml ps
```

Um `GET` público para `/api/whatsapp` sem os parâmetros e o token de verificação
deve retornar `403`. Isso confirma alcance e rejeição segura; não é falha do
webhook.

## Ativação controlada

Depois do modo de simulação e da allowlist passarem nos testes:

1. faça backup do arquivo de segredos;
2. mantenha inicialmente um único número em `WHATSAPP_ALLOWED_SENDERS`;
3. altere `WHATSAPP_DRY_RUN=false`;
4. recrie somente `whatsapp-baixa`;
5. faça uma baixa controlada e confira fila, ocorrência, anexo e resposta;
6. somente após aprovação, use `WHATSAPP_ALLOW_ALL_SENDERS=true`.

Não execute `docker compose down`, não apague volumes e não mostre o conteúdo do
arquivo de segredos.

## Rollback

O rollback da aplicação não exige apagar tabelas ou imagens:

1. restaure o commit ou a imagem Docker anterior;
2. recrie somente o serviço `whatsapp-baixa`;
3. confira `/health/ready` e a fila antes de liberar tráfego.

Para reverter apenas a inicialização automática, restaure os dois arquivos do
último diretório em `/var/backups/twt-whatsapp-autostart`, execute
`systemctl daemon-reload` e reinicie a unidade. Se não havia configuração
anterior, desabilite a unidade e remova somente:

```text
/etc/systemd/system/twt-whatsapp-stack.service
/usr/local/sbin/twt-whatsapp-stack-start
```

Essa remoção não deve incluir containers, volumes, segredos, imagens ou dados do
PostgreSQL.
