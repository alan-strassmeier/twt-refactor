using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography.Xml;
using System.Xml;

namespace Twt.NfseA3Agent;

internal static class DpsSigner
{
    private const string XmlDsigNamespace = "http://www.w3.org/2000/09/xmldsig#";

    internal static string Sign(string unsignedXml, X509Certificate2 certificate, string expectedIssuerCnpj)
    {
        var document = LoadSecureXml(unsignedXml);
        var root = document.DocumentElement;
        var info = document.SelectSingleNode(
            "/*[local-name()='DPS']/*[local-name()='infDPS']") as XmlElement;
        if (root is null || root.LocalName != "DPS" || info is null)
        {
            throw new InvalidOperationException("O trabalho não contém uma DPS reconhecida.");
        }
        if (document.GetElementsByTagName("Signature", XmlDsigNamespace).Count > 0)
        {
            throw new InvalidOperationException("A DPS recebida já contém uma assinatura.");
        }
        var dpsId = info.GetAttribute("Id");
        if (string.IsNullOrWhiteSpace(dpsId) || !dpsId.StartsWith("DPS", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("O atributo Id da DPS é inválido.");
        }
        var issuer = document.SelectSingleNode(
            "/*[local-name()='DPS']/*[local-name()='infDPS']/*[local-name()='prest']/*[local-name()='CNPJ']")
            ?.InnerText;
        if (Digits(issuer) != Digits(expectedIssuerCnpj))
        {
            throw new InvalidOperationException("O CNPJ do prestador da DPS não corresponde à TWT.");
        }

        using var privateKey = certificate.GetRSAPrivateKey()
            ?? throw new InvalidOperationException("A chave RSA do certificado A3 não está acessível.");
        var signedXml = new SignedXml(document)
        {
            SigningKey = privateKey
        };
        var signedInfo = signedXml.SignedInfo
            ?? throw new CryptographicException("Não foi possível inicializar a assinatura XML.");
        signedInfo.CanonicalizationMethod = SignedXml.XmlDsigExcC14NWithCommentsTransformUrl;
        signedInfo.SignatureMethod = SignedXml.XmlDsigRSASHA256Url;

        var reference = new Reference($"#{dpsId}")
        {
            DigestMethod = SignedXml.XmlDsigSHA256Url
        };
        reference.AddTransform(new XmlDsigEnvelopedSignatureTransform());
        reference.AddTransform(new XmlDsigExcC14NWithCommentsTransform());
        signedXml.AddReference(reference);

        var keyInfo = new KeyInfo();
        keyInfo.AddClause(new KeyInfoX509Data(certificate));
        signedXml.KeyInfo = keyInfo;
        signedXml.ComputeSignature();

        var signature = document.ImportNode(signedXml.GetXml(), deep: true);
        root.InsertAfter(signature, info);
        Verify(document, certificate);
        return document.OuterXml;
    }

    private static XmlDocument LoadSecureXml(string xml)
    {
        if (string.IsNullOrWhiteSpace(xml) || xml.Length > 512 * 1024)
        {
            throw new InvalidOperationException("A DPS está vazia ou excede o limite permitido.");
        }
        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 512 * 1024
        };
        var document = new XmlDocument
        {
            PreserveWhitespace = true,
            XmlResolver = null
        };
        using var reader = XmlReader.Create(new StringReader(xml), settings);
        document.Load(reader);
        return document;
    }

    private static void Verify(XmlDocument document, X509Certificate2 certificate)
    {
        var signature = document.GetElementsByTagName("Signature", XmlDsigNamespace)
            .OfType<XmlElement>()
            .SingleOrDefault()
            ?? throw new CryptographicException("A assinatura XML não foi gerada.");
        var verifier = new SignedXml(document);
        verifier.LoadXml(signature);
        if (!verifier.CheckSignature(certificate, verifySignatureOnly: true))
        {
            throw new CryptographicException("A conferência local da assinatura XML falhou.");
        }
    }

    private static string Digits(string? value) =>
        new((value ?? "").Where(char.IsDigit).ToArray());
}
