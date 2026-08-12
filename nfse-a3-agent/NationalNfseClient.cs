using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace Twt.NfseA3Agent;

internal sealed class NationalNfseClient(AgentSettings settings, X509Certificate2 certificate)
{
    private const int MaxResponseBytes = 4 * 1024 * 1024;
    private const int MaxXmlBytes = 2 * 1024 * 1024;

    internal async Task<NfseResult> ProcessAsync(AgentJob job, CancellationToken cancellationToken)
    {
        var baseUri = ValidateBaseUri(job.ApiBaseUrl);
        if (job.Action.Equals("recover", StringComparison.OrdinalIgnoreCase))
        {
            return await QueryDpsAsync(baseUri, job, cancellationToken);
        }

        var signedXml = DpsSigner.Sign(job.UnsignedDpsXml, certificate, settings.ExpectedIssuerCnpj);
        NfseResult inconclusive;
        try
        {
            var posted = await PostDpsAsync(baseUri, signedXml, job.RequestTimeoutMs, cancellationToken);
            if (!posted.Ambiguous) return posted;
            inconclusive = posted;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or InvalidDataException)
        {
            inconclusive = new NfseResult(false, true, false, 0, "", "", [],
                [$"Transmissão inconclusiva: {error.Message}"]);
        }

        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Transmissão inconclusiva; consultando {job.DpsId}.");
        foreach (var delay in new[] { 2, 5, 10 })
        {
            await Task.Delay(TimeSpan.FromSeconds(delay), cancellationToken);
            try
            {
                var recovered = await QueryDpsAsync(baseUri, job, cancellationToken);
                if (recovered.Issued) return recovered;
            }
            catch (Exception queryError) when (queryError is HttpRequestException or TaskCanceledException)
            {
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Consulta ainda indisponível: {queryError.Message}");
            }
        }
        return inconclusive;
    }

    private async Task<NfseResult> PostDpsAsync(Uri baseUri, string signedXml, int timeoutMs,
        CancellationToken cancellationToken)
    {
        using var http = CreateHttpClient(baseUri, timeoutMs);
        var encoded = Convert.ToBase64String(Gzip(Encoding.UTF8.GetBytes(signedXml)));
        using var response = await http.PostAsJsonAsync("nfse", new
        {
            dpsXmlGZipB64 = encoded
        }, JsonOptions.Default, cancellationToken);
        return await ParseNfseResponseAsync(response, notFoundAllowed: false, cancellationToken);
    }

    private async Task<NfseResult> QueryDpsAsync(Uri baseUri, AgentJob job,
        CancellationToken cancellationToken)
    {
        using var http = CreateHttpClient(baseUri, job.RequestTimeoutMs);
        using var response = await http.GetAsync(
            $"dps/{Uri.EscapeDataString(job.DpsId)}", cancellationToken);
        return await ParseNfseResponseAsync(response, notFoundAllowed: true, cancellationToken);
    }

    private HttpClient CreateHttpClient(Uri baseUri, int timeoutMs)
    {
        var handler = new HttpClientHandler
        {
            ClientCertificateOptions = ClientCertificateOption.Manual,
            SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
            CheckCertificateRevocationList = true
        };
        handler.ClientCertificates.Add(certificate);
        var client = new HttpClient(handler)
        {
            BaseAddress = baseUri,
            Timeout = TimeSpan.FromMilliseconds(Math.Clamp(timeoutMs, 5000, 120000))
        };
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TWT-NFSe-A3-Agent/1.0");
        return client;
    }

    private Uri ValidateBaseUri(string value)
    {
        if (!Uri.TryCreate(value.TrimEnd('/') + "/", UriKind.Absolute, out var uri) ||
            !settings.IsAllowedNfseUri(uri))
        {
            throw new InvalidOperationException(
                $"O servidor tentou indicar um endpoint NFS-e não permitido: {value}");
        }
        return uri;
    }

    private static async Task<NfseResult> ParseNfseResponseAsync(HttpResponseMessage response,
        bool notFoundAllowed, CancellationToken cancellationToken)
    {
        if (notFoundAllowed && response.StatusCode == HttpStatusCode.NotFound)
        {
            return new NfseResult(false, false, true, 404, "", "", [],
                ["A DPS não foi encontrada no Ambiente Nacional."]);
        }
        var bytes = await ReadLimitedAsync(response.Content, MaxResponseBytes, cancellationToken);
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(bytes);
        }
        catch (JsonException)
        {
            return new NfseResult(false, response.IsSuccessStatusCode, false,
                (int)response.StatusCode, "", "", [],
                ["A NFS-e Nacional retornou uma resposta JSON inválida."]);
        }
        using (document)
        {
            var root = document.RootElement;
            if (!response.IsSuccessStatusCode)
            {
                var statusCode = (int)response.StatusCode;
                return new NfseResult(false, statusCode == 408 || statusCode >= 500, false,
                    statusCode, "", "", [],
                    ExtractMessages(root));
            }
            var encoded = GetString(root, "nfseXmlGZipB64", "NFSeXmlGZipB64", "xmlGZipB64");
            if (string.IsNullOrWhiteSpace(encoded))
            {
                return new NfseResult(false, true, false, (int)response.StatusCode, "", "", [],
                    ["A resposta não contém o XML autorizado da NFS-e."]);
            }
            string xml;
            try
            {
                xml = Encoding.UTF8.GetString(Gunzip(Convert.FromBase64String(encoded), MaxXmlBytes))
                    .TrimStart('\uFEFF').Trim();
            }
            catch (Exception error) when (error is FormatException or InvalidDataException)
            {
                return new NfseResult(false, true, false, (int)response.StatusCode, "", "", [],
                    [$"O XML autorizado retornado é inválido: {error.Message}"]);
            }
            if (!xml.Contains("<NFSe", StringComparison.Ordinal) ||
                xml.Contains("<!DOCTYPE", StringComparison.OrdinalIgnoreCase) ||
                xml.Contains("<!ENTITY", StringComparison.OrdinalIgnoreCase))
            {
                return new NfseResult(false, true, false, (int)response.StatusCode, "", "", [],
                    ["A resposta contém um XML inesperado."]);
            }
            return new NfseResult(
                true,
                false,
                false,
                (int)response.StatusCode,
                xml,
                GetString(root, "chaveAcesso"),
                ExtractArray(root, "alertas"),
                []);
        }
    }

    internal static Completion ToCompletion(AgentJob job, string agentId, NfseResult result)
    {
        var outcome = result.Issued
            ? "issued"
            : result.Ambiguous
                ? "ambiguous"
                : result.NotFound
                    ? "not_found"
                    : "rejected";
        return new Completion
        {
            AgentId = agentId,
            InvoiceId = job.InvoiceId,
            LeaseToken = job.LeaseToken,
            Outcome = outcome,
            AuthorizedXmlGZipB64 = result.Issued
                ? Convert.ToBase64String(Gzip(Encoding.UTF8.GetBytes(result.AuthorizedXml)))
                : "",
            AccessKey = result.AccessKey,
            UpstreamStatus = result.StatusCode,
            Alerts = result.Alerts,
            Messages = result.Messages
        };
    }

    private static string GetString(JsonElement root, params string[] names)
    {
        foreach (var property in root.EnumerateObject())
        {
            if (names.Contains(property.Name, StringComparer.OrdinalIgnoreCase) &&
                property.Value.ValueKind == JsonValueKind.String)
            {
                return property.Value.GetString() ?? "";
            }
        }
        return "";
    }

    private static string[] ExtractArray(JsonElement root, string name)
    {
        var property = root.EnumerateObject()
            .FirstOrDefault(item => item.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        if (property.Value.ValueKind != JsonValueKind.Array) return [];
        return property.Value.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : item.ToString())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!.ReplaceLineEndings(" ").Trim())
            .Select(value => value[..Math.Min(value.Length, 500)])
            .Take(20)
            .ToArray();
    }

    private static string[] ExtractMessages(JsonElement root)
    {
        var messages = new List<string>();
        Visit(root, messages);
        return messages.Count > 0
            ? messages.Distinct().Take(20).ToArray()
            : ["A DPS foi recusada pela NFS-e Nacional."];

        static void Visit(JsonElement element, List<string> result)
        {
            if (result.Count >= 20) return;
            if (element.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in element.EnumerateObject())
                {
                    if (new[] { "mensagem", "message", "descricao", "detail" }
                            .Contains(property.Name, StringComparer.OrdinalIgnoreCase) &&
                        property.Value.ValueKind == JsonValueKind.String)
                    {
                        var text = property.Value.GetString()?.ReplaceLineEndings(" ").Trim();
                        if (!string.IsNullOrWhiteSpace(text)) result.Add(text[..Math.Min(text.Length, 500)]);
                    }
                    else Visit(property.Value, result);
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in element.EnumerateArray()) Visit(item, result);
            }
        }
    }

    private static byte[] Gzip(byte[] input)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            gzip.Write(input);
        }
        return output.ToArray();
    }

    private static byte[] Gunzip(byte[] input, int maximum)
    {
        using var source = new MemoryStream(input);
        using var gzip = new GZipStream(source, CompressionMode.Decompress);
        using var output = new MemoryStream();
        var buffer = new byte[81920];
        int read;
        while ((read = gzip.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (output.Length + read > maximum) throw new InvalidDataException("XML excede o limite permitido.");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    private static async Task<byte[]> ReadLimitedAsync(HttpContent content, int maximum,
        CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength > maximum)
            throw new InvalidDataException("Resposta da NFS-e excede o limite permitido.");
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream();
        var buffer = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (output.Length + read > maximum)
                throw new InvalidDataException("Resposta da NFS-e excede o limite permitido.");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }
}
