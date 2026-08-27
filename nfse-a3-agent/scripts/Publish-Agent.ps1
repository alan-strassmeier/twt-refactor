$ErrorActionPreference = 'Stop'

$project = Join-Path $PSScriptRoot '..\Twt.NfseA3Agent.csproj'
$output = Join-Path $PSScriptRoot '..\publish\win-x64'

dotnet publish $project `
  --configuration Release `
  --runtime win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  --output $output

Write-Host "Agente publicado em $output" -ForegroundColor Green
