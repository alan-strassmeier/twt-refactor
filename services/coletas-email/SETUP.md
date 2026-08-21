# Serviço automático de coletas por e-mail

Este processo Node fica continuamente ativo, consulta uma caixa Zoho por IMAP,
localiza os domínios externos presentes em `Para` e `CC` e envia somente os PDFs
anexados aos contatos de WhatsApp cadastrados para cada domínio.

Ele não é uma função serverless e não depende do endpoint de consulta de coletas
da Brudam.

## Comportamento

- Todos os domínios externos cadastrados recebem o PDF. Se houver dois domínios,
  os contatos ativos dos dois são atendidos.
- `twt.com.br` é tratado como domínio interno e não participa do roteamento.
- Um domínio sem contato gera um aviso para `twt@twt.com.br`. Os domínios
  conhecidos do mesmo e-mail continuam sendo processados.
- O corpo do e-mail não é encaminhado. A mensagem do WhatsApp contém somente o
  documento, sem legenda.
- O PDF é validado pelos bytes `%PDF-`. Isso é necessário porque o exemplo da
  Brudam declarou o anexo como `text/plain`, apesar de ele ser um PDF válido.
- Cada envio concluído é persistido para impedir duplicidade em reinícios ou
  novas tentativas.
- Falhas temporárias no WhatsApp são tentadas três vezes. Depois disso, um aviso
  é enviado por e-mail.

## Configuração do Zoho

1. Crie uma conta real para a automação, por exemplo
   `automacao-coletas@twt.com.br`. Uma lista de distribuição não possui, por si
   só, uma caixa IMAP própria.
2. Crie a lista `coletas@twt.com.br` e adicione a conta de automação como membro.
   O Zoho entregará uma cópia das mensagens da lista na caixa de cada membro.
   Configure a Brudam para adicionar essa lista aos destinatários, sem substituir
   os e-mails das transportadoras: se restar somente `coletas@twt.com.br` no
   cabeçalho, não haverá domínio externo para determinar o WhatsApp.
3. Permita que o remetente usado pela Brudam envie mensagens à lista. No exemplo
   fornecido, o cabeçalho `From` é `twt@twt.com.br`.
4. Confirme em um teste que a cópia entregue preserva os destinatários externos
   originais nos campos `Para` e `CC`. Esses cabeçalhos determinam o domínio.
5. Ative IMAP na conta de automação. Em contas organizacionais pagas, o padrão é
   `imappro.zoho.com`, porta `993`, com SSL.
6. Se a conta usar autenticação em dois fatores, gere uma senha específica de
   aplicativo para IMAP/SMTP.

## Cadastro dos domínios

Copie `contacts.example.json` para `contacts.json` e substitua os telefones. O
arquivo real é ignorado pelo Git.

Cada domínio pode ter um ou mais contatos ativos:

```json
{
  "domains": {
    "gvrtransportes.com": {
      "company": "GVR Transportes",
      "contacts": [
        {
          "name": "Operacional",
          "phone": "5541999999999",
          "enabled": true
        }
      ]
    }
  }
}
```

Os telefones devem conter código do país e DDD, apenas números.

## Variáveis do processo

```text
COLETAS_IMAP_HOST=imappro.zoho.com
COLETAS_IMAP_PORT=993
COLETAS_IMAP_USER=automacao-coletas@twt.com.br
COLETAS_IMAP_PASSWORD=senha-especifica-do-aplicativo
COLETAS_IMAP_MAILBOX=INBOX

COLETAS_SMTP_HOST=smtppro.zoho.com
COLETAS_SMTP_PORT=465
COLETAS_SMTP_USER=automacao-coletas@twt.com.br
COLETAS_SMTP_PASSWORD=senha-especifica-do-aplicativo
COLETAS_ERROR_FROM=automacao-coletas@twt.com.br
COLETAS_ERROR_TO=twt@twt.com.br

COLETAS_ALLOWED_SENDERS=twt@twt.com.br
COLETAS_INTERNAL_DOMAINS=twt.com.br
COLETAS_POLL_INTERVAL_SECONDS=30
COLETAS_MAX_ATTEMPTS=3
COLETAS_PROCESS_EXISTING=false

WHATSAPP_ACCESS_TOKEN=token-permanente-da-meta
WHATSAPP_PHONE_NUMBER_ID=id-do-numero
WHATSAPP_GRAPH_VERSION=v25.0
```

Na primeira execução, `COLETAS_PROCESS_EXISTING=false` posiciona o cursor no
e-mail mais recente e impede que mensagens antigas sejam encaminhadas. Altere
para `true` somente se quiser processar todo o histórico existente na caixa.

## Execução persistente

Instale as dependências e execute:

```text
npm install
npm run coletas:start
```

Em produção, mantenha o comando ativo com Docker, systemd, PM2 ou outro gerenciador
de processos em um servidor ou VPS com armazenamento persistente. O diretório
`services/coletas-email/data` deve sobreviver aos reinícios.

Para inspecionar um `.eml` local sem enviar e-mail ou WhatsApp:

```text
npm run coletas:inspect -- "caminho/arquivo.eml"
```

## Restrição da API oficial do WhatsApp

O serviço usa uma mensagem do tipo `document`, sem legenda. Esse envio livre só
funciona quando existe uma janela de atendimento ativa com o destinatário. Para
iniciar uma conversa fora dessa janela, a Meta exige um template aprovado. Um
template pode levar o PDF no cabeçalho, mas deixa de ser literalmente “somente o
PDF”. Caso a Meta recuse o documento, o serviço tenta novamente e depois envia o
erro para o endereço configurado.
