# Agente local NFS-e A3 da TWT

Este executável é a ponte entre a área de faturamento hospedada na Vercel e o
certificado A3 físico conectado a um computador Windows da empresa. A chave
privada e o PIN nunca saem do token nem são enviados ao site.

## Fluxo

1. A Vercel cria e enfileira uma DPS não assinada.
2. O agente consulta a fila por HTTPS usando um token próprio.
3. O agente confere o CNPJ do prestador, assina a DPS com o certificado escolhido
   pelo thumbprint e transmite para o Ambiente Nacional usando mTLS.
4. O XML autorizado volta para a Vercel, que o valida e guarda no R2.
5. Se o agente cair durante a transmissão, a próxima execução consulta o Id da
   DPS antes de qualquer nova tentativa, evitando uma nota duplicada.

## 1. Configuração da Vercel

Cadastre em Production e Preview:

```dotenv
NFSE_CERT_MODE=agent
NFSE_AGENT_TOKEN=<token aleatório com pelo menos 32 caracteres>
NFSE_AGENT_LEASE_MS=300000
```

Com o modo `agent`, `NFSE_CERT_PFX_BASE64` e `NFSE_CERT_PASSWORD` não são usados.
As demais variáveis da NFS-e, Redis e R2 continuam obrigatórias.

Para gerar o token em versões antigas do Windows PowerShell:

```powershell
$bytes = New-Object byte[] 48
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[Convert]::ToBase64String($bytes)
```

Depois de atualizar as variáveis, faça um novo deployment.

## 2. Preparação do computador emissor

- Windows 10/11 de 64 bits, mantido ligado e conectado à internet.
- Driver/middleware oficial do token A3 instalado.
- Token conectado e certificado visível em `certmgr.msc` > Pessoal > Certificados.
- Usuário do Windows dedicado ao faturamento. O agente deve executar dentro da
  sessão desse usuário porque alguns drivers exibem a janela de PIN.

O PIN não deve ser colocado no `agentsettings.json`, na Vercel nem em variável de
ambiente. Ele é solicitado diretamente pelo software do token.

## 3. Publicação do executável

Em um computador de desenvolvimento com o SDK .NET 8:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\Publish-Agent.ps1
```

O resultado fica em `publish\win-x64` e é autocontido: o computador emissor não
precisa instalar o .NET.

## 4. Encontrar o certificado correto

No computador com o token conectado:

```powershell
.\Twt.NfseA3Agent.exe --list-certificates
```

Copie o thumbprint do e-CNPJ da TWT. O agente sempre usa exatamente esse
certificado e recusa uma DPS cujo prestador não seja o CNPJ `09.123.137/0001-08`.

## 5. Instalação e inicialização automática

Abra o PowerShell dentro da pasta publicada e execute:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-Agent.ps1 -CertificateThumbprint "THUMBPRINT_COPIADO"
```

O instalador:

- solicita o mesmo `NFSE_AGENT_TOKEN` da Vercel;
- copia o agente para `%LOCALAPPDATA%\TWT\NfseA3Agent`;
- cria o `agentsettings.json`;
- adiciona um atalho à inicialização do usuário;
- inicia o agente para validar a conexão.

## Diagnóstico

```powershell
# Confere certificado, token e comunicação com a Vercel sem buscar trabalhos
.\Twt.NfseA3Agent.exe --health

# Busca no máximo um trabalho e encerra
.\Twt.NfseA3Agent.exe --once

# Testa localmente a assinatura XML sem acessar o token nem a internet
.\Twt.NfseA3Agent.exe --self-test
```

Se o middleware pedir o PIN a cada assinatura, mantenha o agente como aplicativo
de inicialização, e não como serviço do Windows. Se o token bloquear o PIN após
tentativas incorretas, interrompa os testes e use o procedimento de desbloqueio da
autoridade certificadora.
