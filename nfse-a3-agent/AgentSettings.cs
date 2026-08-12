using System.Text.Json;

namespace Twt.NfseA3Agent;

internal sealed class AgentSettings
{
    public string ServerUrl { get; set; } = "https://www.twt.com.br/api/faturamento/nfse-agent";
    public string AgentId { get; set; } = $"twt-{Environment.MachineName.ToLowerInvariant()}";
    public string CertificateThumbprint { get; set; } = "";
    public string ExpectedIssuerCnpj { get; set; } = "09123137000108";
    public int PollIntervalSeconds { get; set; } = 5;
    public string[] AllowedNfseHosts { get; set; } =
    [
        "sefin.producaorestrita.nfse.gov.br",
        "sefin.nfse.gov.br"
    ];

    public string AgentToken { get; private set; } = "";

    public static AgentSettings Load(string? path = null)
    {
        path ??= Path.Combine(AppContext.BaseDirectory, "agentsettings.json");
        if (!File.Exists(path))
        {
            throw new InvalidOperationException(
                $"Configuração não encontrada em {path}. Copie agentsettings.example.json para agentsettings.json.");
        }

        var json = File.ReadAllText(path);
        var settings = JsonSerializer.Deserialize<AgentSettings>(json, JsonOptions.Default)
            ?? throw new InvalidOperationException("agentsettings.json está vazio ou inválido.");
        settings.ApplyEnvironmentOverrides();
        settings.Validate();
        return settings;
    }

    private void ApplyEnvironmentOverrides()
    {
        ServerUrl = Environment.GetEnvironmentVariable("TWT_NFSE_AGENT_SERVER_URL")?.Trim()
            ?? ServerUrl.Trim();
        AgentId = Environment.GetEnvironmentVariable("TWT_NFSE_AGENT_ID")?.Trim()
            ?? AgentId.Trim();
        CertificateThumbprint = Environment.GetEnvironmentVariable("TWT_NFSE_CERT_THUMBPRINT")?.Trim()
            ?? CertificateThumbprint.Trim();
        AgentToken = Environment.GetEnvironmentVariable("TWT_NFSE_AGENT_TOKEN")?.Trim() ?? "";
    }

    private void Validate()
    {
        if (!Uri.TryCreate(ServerUrl, UriKind.Absolute, out var serverUri) ||
            serverUri.Scheme != Uri.UriSchemeHttps)
        {
            throw new InvalidOperationException("ServerUrl deve ser uma URL HTTPS absoluta.");
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(AgentId, "^[A-Za-z0-9._-]{1,64}$"))
        {
            throw new InvalidOperationException("AgentId aceita apenas letras, números, ponto, hífen e sublinhado.");
        }
        CertificateThumbprint = CertificateProvider.NormalizeThumbprint(CertificateThumbprint);
        if (CertificateThumbprint.Length < 32)
        {
            throw new InvalidOperationException("CertificateThumbprint não foi configurado.");
        }
        ExpectedIssuerCnpj = Digits(ExpectedIssuerCnpj);
        if (ExpectedIssuerCnpj.Length != 14)
        {
            throw new InvalidOperationException("ExpectedIssuerCnpj deve conter os 14 dígitos do CNPJ da TWT.");
        }
        if (AgentToken.Length < 32)
        {
            throw new InvalidOperationException(
                "Defina TWT_NFSE_AGENT_TOKEN com o mesmo token NFSE_AGENT_TOKEN cadastrado na Vercel.");
        }
        PollIntervalSeconds = Math.Clamp(PollIntervalSeconds, 2, 60);
        AllowedNfseHosts = AllowedNfseHosts
            .Select(host => host.Trim().ToLowerInvariant())
            .Where(host => host.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (AllowedNfseHosts.Length == 0)
        {
            throw new InvalidOperationException("AllowedNfseHosts deve conter os hosts oficiais da NFS-e.");
        }
    }

    internal bool IsAllowedNfseUri(Uri uri) =>
        uri.Scheme == Uri.UriSchemeHttps &&
        AllowedNfseHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase);

    private static string Digits(string value) => new(value.Where(char.IsDigit).ToArray());
}

internal static class JsonOptions
{
    internal static readonly JsonSerializerOptions Default = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false
    };
}
