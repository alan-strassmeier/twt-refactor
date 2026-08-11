using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography;

namespace Twt.NfseA3Agent;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        if (args.Contains("--list-certificates", StringComparer.OrdinalIgnoreCase))
        {
            ListCertificates();
            return 0;
        }
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
        {
            SelfTest();
            return 0;
        }

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };

        try
        {
            var settings = AgentSettings.Load();
            using var certificate = CertificateProvider.FindByThumbprint(settings.CertificateThumbprint);
            PrintHeader(settings, certificate);

            using var agentApi = new AgentApiClient(settings);
            var health = await agentApi.HealthAsync(cancellation.Token);
            if (!health.Ok || !health.CertificateMode.Equals("agent", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "A Vercel respondeu, mas NFSE_CERT_MODE ainda não está configurado como agent.");
            }
            Console.WriteLine(
                $"[{DateTime.Now:HH:mm:ss}] Conectado à Vercel. Ambiente NFS-e: {health.Environment}.");
            if (args.Contains("--health", StringComparer.OrdinalIgnoreCase)) return 0;

            var once = args.Contains("--once", StringComparer.OrdinalIgnoreCase);
            var nationalClient = new NationalNfseClient(settings, certificate);
            do
            {
                var processed = await PollOnceAsync(
                    settings, agentApi, nationalClient, cancellation.Token);
                if (once) break;
                if (!processed)
                {
                    await Task.Delay(
                        TimeSpan.FromSeconds(settings.PollIntervalSeconds), cancellation.Token);
                }
            } while (!cancellation.IsCancellationRequested);

            return 0;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            Console.WriteLine("Agente encerrado.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ERRO: {error.Message}");
            Console.Error.WriteLine("Use --list-certificates para conferir os certificados disponíveis.");
            return 1;
        }
    }

    private static async Task<bool> PollOnceAsync(AgentSettings settings, AgentApiClient agentApi,
        NationalNfseClient nationalClient, CancellationToken cancellationToken)
    {
        AgentJob? job;
        try
        {
            job = await agentApi.ClaimAsync(cancellationToken);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or AgentApiException)
        {
            Console.Error.WriteLine($"[{DateTime.Now:HH:mm:ss}] Vercel indisponível: {error.Message}");
            return false;
        }
        if (job is null) return false;

        Console.WriteLine(
            $"[{DateTime.Now:HH:mm:ss}] Fatura {job.InvoiceId}: " +
            (job.Action == "recover" ? "conferindo DPS" : "assinando e transmitindo DPS") +
            $" {job.DpsNumber}.");
        NfseResult result;
        try
        {
            result = await nationalClient.ProcessAsync(job, cancellationToken);
        }
        catch (Exception error)
        {
            result = new NfseResult(false, false, false, 0, "", "", [],
                [$"Falha local no agente: {error.Message}"]);
        }

        var completion = NationalNfseClient.ToCompletion(job, settings.AgentId, result);
        await agentApi.CompleteWithRetryAsync(completion, cancellationToken);
        if (result.Issued)
        {
            Console.WriteLine(
                $"[{DateTime.Now:HH:mm:ss}] Fatura {job.InvoiceId}: NFS-e autorizada e devolvida à Vercel.");
        }
        else
        {
            Console.Error.WriteLine(
                $"[{DateTime.Now:HH:mm:ss}] Fatura {job.InvoiceId}: {string.Join(" | ", result.Messages)}");
        }
        return true;
    }

    private static void PrintHeader(AgentSettings settings, X509Certificate2 certificate)
    {
        Console.WriteLine("TWT — Agente local NFS-e A3");
        Console.WriteLine($"Agente: {settings.AgentId}");
        Console.WriteLine($"Certificado: {certificate.GetNameInfo(X509NameType.SimpleName, false)}");
        Console.WriteLine($"Thumbprint: {certificate.Thumbprint}");
        Console.WriteLine($"Validade: {certificate.NotBefore:d} a {certificate.NotAfter:d}");
        Console.WriteLine("O PIN é tratado exclusivamente pelo driver do token e nunca é enviado à Vercel.");
    }

    private static void ListCertificates()
    {
        var certificates = CertificateProvider.ListSigningCertificates();
        if (certificates.Count == 0)
        {
            Console.WriteLine("Nenhum certificado com chave privada foi encontrado.");
            return;
        }
        foreach (var (location, certificate) in certificates)
        {
            using (certificate)
            {
                Console.WriteLine($"[{location}] {certificate.GetNameInfo(X509NameType.SimpleName, false)}");
                Console.WriteLine($"  Thumbprint: {certificate.Thumbprint}");
                Console.WriteLine($"  Validade: {certificate.NotBefore:d} a {certificate.NotAfter:d}");
                Console.WriteLine();
            }
        }
    }

    private static void SelfTest()
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=TWT Agent Self Test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var certificate = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(10));
        const string cnpj = "09123137000108";
        const string xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
            "<DPS xmlns=\"http://www.sped.fazenda.gov.br/nfse\" versao=\"1.01\">" +
            "<infDPS Id=\"DPS431490220912313700010881001000000000000001\">" +
            "<prest><CNPJ>09123137000108</CNPJ></prest></infDPS></DPS>";
        var signed = DpsSigner.Sign(xml, certificate, cnpj);
        if (!signed.Contains("<Signature", StringComparison.Ordinal) ||
            !signed.Contains("<X509Certificate>", StringComparison.Ordinal))
        {
            throw new CryptographicException("O autoteste não encontrou a assinatura esperada.");
        }
        Console.WriteLine("Autoteste concluído: assinatura XML RSA-SHA256 válida.");
    }
}
