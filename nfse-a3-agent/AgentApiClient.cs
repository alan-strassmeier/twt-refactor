using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Twt.NfseA3Agent;

internal sealed class AgentApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly AgentSettings _settings;

    internal AgentApiClient(AgentSettings settings)
    {
        _settings = settings;
        _http = new HttpClient
        {
            BaseAddress = new Uri(settings.ServerUrl),
            Timeout = TimeSpan.FromSeconds(30)
        };
        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", settings.AgentToken);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("TWT-NFSe-A3-Agent/1.0");
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    internal async Task<AgentHealth> HealthAsync(CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync("", cancellationToken);
        return await ReadJsonAsync<AgentHealth>(response, cancellationToken);
    }

    internal async Task<AgentJob?> ClaimAsync(CancellationToken cancellationToken)
    {
        using var response = await _http.PostAsJsonAsync("", new
        {
            action = "claim",
            agentId = _settings.AgentId
        }, JsonOptions.Default, cancellationToken);
        var payload = await ReadJsonAsync<ClaimResponse>(response, cancellationToken);
        return payload.Job;
    }

    internal async Task CompleteWithRetryAsync(Completion completion, CancellationToken cancellationToken)
    {
        Exception? lastError = null;
        foreach (var delay in new[] { TimeSpan.Zero, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5) })
        {
            if (delay > TimeSpan.Zero) await Task.Delay(delay, cancellationToken);
            try
            {
                using var response = await _http.PostAsJsonAsync(
                    "", completion, JsonOptions.Default, cancellationToken);
                await EnsureSuccessAsync(response, cancellationToken);
                return;
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException or AgentApiException)
            {
                lastError = error;
                if (error is AgentApiException apiError &&
                    apiError.StatusCode is >= 400 and < 500 and not 408 and not 409 and not 429)
                {
                    break;
                }
            }
        }
        throw new AgentApiException(
            $"Não foi possível devolver o resultado à Vercel: {lastError?.Message}");
    }

    private static async Task<T> ReadJsonAsync<T>(HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (!response.IsSuccessStatusCode)
        {
            await EnsureSuccessAsync(response, cancellationToken);
        }
        return await response.Content.ReadFromJsonAsync<T>(JsonOptions.Default, cancellationToken)
            ?? throw new AgentApiException("A Vercel retornou uma resposta JSON vazia.", (int)response.StatusCode);
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        string message;
        try
        {
            message = JsonSerializer.Deserialize<ApiErrorPayload>(body, JsonOptions.Default)?.Message ?? body;
        }
        catch (JsonException)
        {
            message = body;
        }
        message = string.IsNullOrWhiteSpace(message)
            ? $"HTTP {(int)response.StatusCode}"
            : message.ReplaceLineEndings(" ").Trim();
        throw new AgentApiException(message, (int)response.StatusCode);
    }

    public void Dispose() => _http.Dispose();
}
