param(
  [string]$ServerUrl = 'https://www.twt.com.br/api/faturamento/nfse-agent',
  [string]$AgentId = ('twt-' + $env:COMPUTERNAME.ToLowerInvariant()),
  [Parameter(Mandatory = $true)]
  [string]$CertificateThumbprint
)

$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
if (Test-Path (Join-Path $PSScriptRoot 'Twt.NfseA3Agent.exe')) {
  $source = $PSScriptRoot
}
$executable = Join-Path $source 'Twt.NfseA3Agent.exe'
if (-not (Test-Path $executable)) {
  throw 'Execute este instalador a partir da pasta publicada do agente.'
}

$secureToken = Read-Host 'Cole o NFSE_AGENT_TOKEN cadastrado na Vercel' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 32) {
    throw 'O token precisa ter pelo menos 32 caracteres.'
  }
  [Environment]::SetEnvironmentVariable('TWT_NFSE_AGENT_TOKEN', $token, 'User')
  $env:TWT_NFSE_AGENT_TOKEN = $token
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $token = $null
}

$installDirectory = Join-Path $env:LOCALAPPDATA 'TWT\NfseA3Agent'
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
Copy-Item (Join-Path $source '*') $installDirectory -Recurse -Force

$settings = [ordered]@{
  ServerUrl = $ServerUrl
  AgentId = $AgentId
  CertificateThumbprint = ($CertificateThumbprint -replace '[^A-Fa-f0-9]', '').ToUpperInvariant()
  ExpectedIssuerCnpj = '09123137000108'
  PollIntervalSeconds = 5
  AllowedNfseHosts = @(
    'sefin.producaorestrita.nfse.gov.br',
    'sefin.nfse.gov.br'
  )
}
$settings | ConvertTo-Json -Depth 4 | Set-Content `
  (Join-Path $installDirectory 'agentsettings.json') -Encoding UTF8

$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'TWT NFS-e A3 Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $installDirectory 'Twt.NfseA3Agent.exe'
$shortcut.WorkingDirectory = $installDirectory
$shortcut.Description = 'Agente local de emissão NFS-e com certificado A3 da TWT'
$shortcut.Save()

Write-Host "Instalado em $installDirectory" -ForegroundColor Green
Write-Host 'O agente iniciará quando este usuário entrar no Windows.'
Write-Host 'Iniciando agora para validar a configuração e solicitar o PIN, se necessário.'
Start-Process -FilePath (Join-Path $installDirectory 'Twt.NfseA3Agent.exe') `
  -WorkingDirectory $installDirectory
