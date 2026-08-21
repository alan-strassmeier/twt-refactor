# Integração Brudam na Vercel

O rastreamento usa a função serverless `api/rastreamento.js`. O navegador chama apenas `/api/rastreamento`; usuário, senha e JWT da Brudam ficam nas variáveis de ambiente da Vercel e não são enviados para o cliente.

Configure estas variáveis no painel da Vercel, em **Project Settings > Environment Variables**:

- `BRUDAM_API_USER`: usuário hexadecimal de 32 caracteres da tela 669 da Brudam.
- `BRUDAM_API_PASSWORD`: senha hexadecimal de 64 caracteres da tela 669 da Brudam.
- `BRUDAM_API_URL`: opcional. Padrão: `https://twt.brudam.com.br/api/v1`.

Depois de configurar as variáveis, faça um novo deploy. Se o rastreamento retornar `Integração de rastreamento não configurada.`, alguma variável não foi criada no ambiente usado pelo deploy.

Não coloque esses valores em JavaScript, HTML, arquivos versionados ou parâmetros de URL. Se algum token ou senha já ficou público em testes anteriores, gere uma nova credencial na Brudam antes de publicar.
