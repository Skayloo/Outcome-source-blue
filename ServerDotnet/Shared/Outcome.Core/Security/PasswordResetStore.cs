using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Caching.Memory;
using Outcome.Shared.Abstractions.Security;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure.Security;

/// <inheritdoc cref="IPasswordResetStore"/>
public sealed class PasswordResetStore(IMemoryCache cache, ICurrentSpace space) : IPasswordResetStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private const int MaxFailures = 5;

    private sealed class Entry
    {
        public required string Code { get; init; }
        public int Failures;
    }

    // Normalize the email so the "forgot" and "reset" steps hit the same key regardless of casing.
    // Scoped to the space as well: one process-wide IMemoryCache serves every space, and the same
    // address can belong to two unrelated accounts in two of them. A code issued for one must not
    // unlock the other, and one space's request must not evict the other's pending code.
    private string Key(string email) => $"pwreset:s{space.Space.Id}:{email.Trim().ToLowerInvariant()}";

    public void Issue(string email, string code) =>
        cache.Set(Key(email), new Entry { Code = code }, Ttl);

    public bool Verify(string email, string code)
    {
        if (!cache.TryGetValue(Key(email), out Entry? e)) return false;
        if (FixedTimeEquals(e!.Code, code))
        {
            cache.Remove(Key(email));
            return true;
        }
        // Wrong code: burn one of the 5 attempts so the 6-digit space can't be brute-forced.
        if (Interlocked.Increment(ref e.Failures) >= MaxFailures)
            cache.Remove(Key(email));
        return false;
    }

    private static bool FixedTimeEquals(string a, string b)
    {
        var ba = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return ba.Length == bb.Length && CryptographicOperations.FixedTimeEquals(ba, bb);
    }
}
