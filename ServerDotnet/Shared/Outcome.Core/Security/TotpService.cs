using System.Security.Cryptography;
using OtpNet;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Infrastructure.Security;

/// <summary>RFC 6238 TOTP (SHA1, 6 digits, 30s, ±1 window) — matches Server/auth/totp.go.</summary>
public sealed class TotpService : ITotpService
{
    public string GenerateSecret() => Base32Encoding.ToString(RandomNumberGenerator.GetBytes(20));

    public string BuildUri(string username, string secret, string issuer)
    {
        var label = Uri.EscapeDataString($"{issuer}:{username}");
        var query = $"secret={Uri.EscapeDataString(secret)}&issuer={Uri.EscapeDataString(issuer)}&algorithm=SHA1&digits=6&period=30";
        return $"otpauth://totp/{label}?{query}";
    }

    public bool Verify(string secret, string code, DateTime atUtc)
    {
        if (string.IsNullOrWhiteSpace(code) || code.Length != 6) return false;
        try
        {
            var totp = new Totp(Base32Encoding.ToBytes(secret.Trim()), step: 30, mode: OtpHashMode.Sha1, totpSize: 6);
            return totp.VerifyTotp(atUtc, code, out _, new VerificationWindow(previous: 1, future: 1));
        }
        catch
        {
            return false;
        }
    }
}
