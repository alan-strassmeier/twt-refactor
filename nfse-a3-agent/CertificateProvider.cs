using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Twt.NfseA3Agent;

internal static class CertificateProvider
{
    internal static string NormalizeThumbprint(string value) =>
        new(value.Where(Uri.IsHexDigit).Select(char.ToUpperInvariant).ToArray());

    internal static X509Certificate2 FindByThumbprint(string thumbprint)
    {
        var normalized = NormalizeThumbprint(thumbprint);
        foreach (var location in new[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine })
        {
            using var store = new X509Store(StoreName.My, location);
            store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
            var match = store.Certificates
                .Find(X509FindType.FindByThumbprint, normalized, validOnly: false)
                .OfType<X509Certificate2>()
                .FirstOrDefault();
            if (match is null) continue;

            var certificate = new X509Certificate2(match);
            Validate(certificate);
            return certificate;
        }
        throw new InvalidOperationException(
            $"Certificado {normalized} não encontrado em Pessoal/Meus certificados do Windows.");
    }

    internal static IReadOnlyList<(StoreLocation Location, X509Certificate2 Certificate)> ListSigningCertificates()
    {
        var result = new List<(StoreLocation, X509Certificate2)>();
        foreach (var location in new[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine })
        {
            using var store = new X509Store(StoreName.My, location);
            store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
            foreach (var certificate in store.Certificates.OfType<X509Certificate2>())
            {
                if (!certificate.HasPrivateKey) continue;
                if (certificate.PublicKey.Oid?.Value != "1.2.840.113549.1.1.1") continue;
                // Não acessa a chave privada durante a listagem para evitar pedir o PIN do token.
                result.Add((location, new X509Certificate2(certificate)));
            }
        }
        return result;
    }

    private static void Validate(X509Certificate2 certificate)
    {
        var now = DateTime.Now;
        if (now < certificate.NotBefore || now > certificate.NotAfter)
        {
            throw new InvalidOperationException(
                $"O certificado selecionado não está válido na data atual ({certificate.NotBefore:d} a {certificate.NotAfter:d}).");
        }
        if (!certificate.HasPrivateKey)
        {
            throw new InvalidOperationException("O certificado selecionado não possui uma chave privada acessível.");
        }
        using var rsa = certificate.GetRSAPrivateKey();
        if (rsa is null)
        {
            throw new InvalidOperationException("O certificado selecionado não possui chave RSA para assinatura.");
        }
        var keyUsage = certificate.Extensions.OfType<X509KeyUsageExtension>().FirstOrDefault();
        if (keyUsage is not null &&
            !keyUsage.KeyUsages.HasFlag(X509KeyUsageFlags.DigitalSignature) &&
            !keyUsage.KeyUsages.HasFlag(X509KeyUsageFlags.NonRepudiation))
        {
            throw new InvalidOperationException("O certificado não permite assinatura digital.");
        }
    }
}
