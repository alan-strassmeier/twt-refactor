# Integração Brudam

> O site está temporariamente usando o modo de teste direto no navegador em `rastreamento.js`. As credenciais são solicitadas a cada recarregamento e mantidas somente na memória. Esse modo continua inadequado para produção.

O endpoint `rastreamento.php` mantém as credenciais da Brudam fora do navegador e expõe somente uma consulta normalizada ao site.

Configure estas variáveis de ambiente no painel da hospedagem:

- `BRUDAM_API_USER`: usuário hexadecimal de 32 caracteres fornecido pela Brudam.
- `BRUDAM_API_PASSWORD`: senha hexadecimal de 64 caracteres fornecida pela Brudam.

Não coloque esses valores em JavaScript, HTML, arquivos versionados ou parâmetros de URL. O servidor precisa ter PHP com a extensão cURL habilitada; APCu é opcional e usado apenas para cache temporário do JWT.

Revogue o token antigo que estava exposto no JavaScript e configure limitação de requisições também na hospedagem ou CDN. O endpoint possui uma proteção adicional por origem e, quando APCu está disponível, limita consultas repetidas por endereço IP.
