# Área interna de importação de NF-e

A rota `/nfe` recebe chaves de acesso de 44 dígitos. O processamento ocorre
somente no servidor e não usa serviços pagos:

1. Chaves são consultadas diretamente no Web Service `NFeDistribuicaoDFe` do
   Ambiente Nacional da SEFAZ, com o certificado digital A1 da TWT.
2. XMLs retornados pela SEFAZ são validados e interpretados localmente.
3. O funcionário informa o número de uma minuta que já existe na Brudam.
4. As NF-es devem ser acrescentadas a essa minuta, sem emitir uma nova.

A aplicação não chama `/operacional/emissao/minuta`. A documentação pública
atual da Brudam permite emitir, consultar e cancelar minutas, mas não documenta
uma operação para acrescentar NF-es a uma minuta existente. Por segurança, o
processamento permanece bloqueado até a Brudam fornecer essa operação.

A SEFAZ somente libera o XML completo quando o CNPJ do certificado participa da
NF-e como destinatário, transportador ou terceiro autorizado em
`autXML`. Se a TWT não estiver autorizada, a aplicação informa isso sem criar
uma minuta.

A consulta pontual `consChNFe` é limitada oficialmente a 20 chamadas por CNPJ
em uma hora e alcança documentos de até 90 dias. A aplicação controla essa cota,
evita repetir chaves concluídas e mantém um cache temporário criptografado com
`NFE_SESSION_SECRET`.

## Variáveis de ambiente

Configure no projeto da Vercel:

```text
NFE_PORTAL_USER=twt
NFE_PORTAL_PASSWORD
NFE_SESSION_SECRET                  # no mínimo 32 caracteres aleatórios
SEFAZ_CERTIFICATE_PFX_BASE64        # conteúdo do certificado .pfx em Base64
SEFAZ_CERTIFICATE_PASSWORD
SEFAZ_ACTOR_CNPJ                    # padrão: 97434690000129
SEFAZ_AUTHOR_UF_CODE                # padrão: 43 (RS)
BRUDAM_API_USER
BRUDAM_API_PASSWORD
BRUDAM_API_URL                      # opcional
```

As variáveis `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`, já usadas
pelo fluxo de WhatsApp, poderão ser aproveitadas para impedir que uma mesma
NF-e seja vinculada duas vezes à mesma minuta.

Nunca coloque senhas, chaves de API ou tokens nos arquivos do site.

