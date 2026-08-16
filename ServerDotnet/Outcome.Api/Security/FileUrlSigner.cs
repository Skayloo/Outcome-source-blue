using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Security;
using Outcome.Api.Jwt;

namespace Outcome.Api.Security;

/// <summary>
/// HMAC-SHA256 over "id|expiry", keyed by the JWT secret.
///
/// Reusing that key is deliberate: it already has to be secret, already has to be identical
/// across replicas, and already invalidates every session when it is rotated — which is exactly
/// the behaviour wanted here, since a link is a credential of the same kind.
///
/// A WEEK of validity, not an hour. These URLs go into <c>&lt;img src&gt;</c>, and the browser
/// caches per full URL: a shorter life would re-download every picture in a conversation each
/// time the signature turned over. A week bounds a leaked link without making the cache useless.
/// </summary>
public sealed class FileUrlSigner(IOptions<JwtAuthOptions> jwt) : IFileUrlSigner
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    public string Sign(string attachmentId)
    {
        // The expiry is QUANTISED to the UTC day, which is the whole point: a link minted from
        // the current second is a different URL every time it is issued, and a cache keyed by
        // URL — every browser's, and the phone's — misses on every one of them. The week above
        // bought nothing while this line handed out a fresh link per request. Same picture, same
        // URL, all day; the signature turns over once at midnight.
        var today = new DateTimeOffset(DateTime.UtcNow.Date, TimeSpan.Zero);
        var exp = today.Add(Lifetime).ToUnixTimeSeconds();
        return $"/api/v1/files/{attachmentId}?e={exp}&s={Mac(attachmentId, exp)}";
    }

    public bool Verify(string attachmentId, string? expires, string? signature)
    {
        if (string.IsNullOrEmpty(expires) || string.IsNullOrEmpty(signature)) return false;
        if (!long.TryParse(expires, out var exp)) return false;
        if (DateTimeOffset.FromUnixTimeSeconds(exp) < DateTimeOffset.UtcNow) return false;

        // Fixed-time comparison: a byte-by-byte one leaks, through timing, how much of a guessed
        // signature was right — which is enough to build the rest of it a byte at a time.
        var expected = Encoding.ASCII.GetBytes(Mac(attachmentId, exp));
        var given = Encoding.ASCII.GetBytes(signature);
        return expected.Length == given.Length && CryptographicOperations.FixedTimeEquals(expected, given);
    }

    private string Mac(string id, long exp)
    {
        var mac = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(jwt.Value.JwtKey),
            Encoding.UTF8.GetBytes($"{id}|{exp}"));
        // 128 bits is far past guessing, and keeps the URL short enough to read in a log.
        return Convert.ToBase64String(mac.AsSpan(0, 16))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }
}
