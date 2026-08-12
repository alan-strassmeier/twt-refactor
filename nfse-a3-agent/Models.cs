using System.Text.Json.Serialization;

namespace Twt.NfseA3Agent;

internal sealed class AgentHealth
{
    public bool Ok { get; set; }
    public string CertificateMode { get; set; } = "";
    public string Environment { get; set; } = "";
    public DateTimeOffset ServerTime { get; set; }
}

internal sealed class ClaimResponse
{
    public AgentJob? Job { get; set; }
}

internal sealed class AgentJob
{
    public string JobId { get; set; } = "";
    public string InvoiceId { get; set; } = "";
    public string Action { get; set; } = "";
    public string Environment { get; set; } = "";
    public string ApiBaseUrl { get; set; } = "";
    public int RequestTimeoutMs { get; set; }
    public string DpsId { get; set; } = "";
    public string DpsNumber { get; set; } = "";
    public string DpsSeries { get; set; } = "";
    public string UnsignedDpsXml { get; set; } = "";
    public string LeaseToken { get; set; } = "";
    public DateTimeOffset LeaseExpiresAt { get; set; }
}

internal sealed class Completion
{
    public string Action { get; set; } = "complete";
    public string AgentId { get; set; } = "";
    public string InvoiceId { get; set; } = "";
    public string LeaseToken { get; set; } = "";
    public string Outcome { get; set; } = "";
    public string AuthorizedXmlGZipB64 { get; set; } = "";
    public string AccessKey { get; set; } = "";
    public int UpstreamStatus { get; set; }
    public string[] Alerts { get; set; } = [];
    public string[] Messages { get; set; } = [];
}

internal sealed class ApiErrorPayload
{
    public string Message { get; set; } = "";
}

internal sealed record NfseResult(
    bool Issued,
    bool Ambiguous,
    bool NotFound,
    int StatusCode,
    string AuthorizedXml,
    string AccessKey,
    string[] Alerts,
    string[] Messages);

internal sealed class AgentApiException(string message, int statusCode = 0) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}
