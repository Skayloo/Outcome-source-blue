using Isopoh.Cryptography.Argon2;
using Microsoft.AspNetCore.Identity;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Security;

/// <summary>
/// Argon2id password hasher for ASP.NET Core Identity — a memory-hard KDF that resists
/// GPU/ASIC cracking far better than the framework default (PBKDF2). Fully managed
/// (Isopoh), so it keeps the no-native-deps posture of the rest of the stack.
///
/// Migration is transparent: legacy PBKDF2 hashes (created before this hasher) still verify
/// via the built-in hasher and return <see cref="PasswordVerificationResult.SuccessRehashNeeded"/>,
/// which <c>UserManager.CheckPasswordAsync</c> uses to silently re-hash the password to
/// Argon2id on the user's next successful login. No forced reset.
/// </summary>
public sealed class Argon2PasswordHasher : IPasswordHasher<User>
{
    // OWASP's recommended Argon2id configuration: m=19 MiB, t=2, p=1.
    //
    // These used to be m=64 MiB, t=3 "because logins are infrequent and the cost is tens of
    // ms". That claim was wrong for a MANAGED Argon2: measured at ~144 ms on an M-series Mac
    // and several times that inside the server's 1-CPU container — a full extra second on
    // every sign-in, on web and mobile alike. m=19 MiB, t=2 is ~5x cheaper and is still the
    // configuration OWASP publishes, so the trade is latency for nothing.
    private const int MemoryKib = 19456;    // 19 MiB
    private const int TimeCost = 2;         // iterations
    private const int Parallelism = 1;      // lanes (the container is capped at 1 CPU)
    private const int HashLength = 32;      // bytes

    // Built-in PBKDF2 hasher, used ONLY to verify pre-existing legacy hashes.
    private readonly PasswordHasher<User> _legacy = new();

    public string HashPassword(User user, string password) => Argon2.Hash(
        password,
        timeCost: TimeCost,
        memoryCost: MemoryKib,
        parallelism: Parallelism,
        type: Argon2Type.HybridAddressing, // = Argon2id
        hashLength: HashLength);

    public PasswordVerificationResult VerifyHashedPassword(
        User user, string hashedPassword, string providedPassword)
    {
        if (string.IsNullOrEmpty(hashedPassword)) return PasswordVerificationResult.Failed;

        // Our own Argon2 hashes are PHC-encoded ("$argon2id$v=19$m=…,t=…,p=…$salt$hash").
        if (hashedPassword.StartsWith("$argon2", StringComparison.Ordinal))
        {
            if (!Argon2.Verify(hashedPassword, providedPassword))
                return PasswordVerificationResult.Failed;
            // A hash carries the parameters it was made with, so an account created under the
            // old, heavy settings would keep paying that cost forever. Asking Identity to
            // rehash migrates it to the current parameters on this very login.
            return UsesCurrentParameters(hashedPassword)
                ? PasswordVerificationResult.Success
                : PasswordVerificationResult.SuccessRehashNeeded;
        }

        // Legacy PBKDF2 hash → verify with the framework hasher, then ask Identity to
        // upgrade it to Argon2id on this login.
        var legacy = _legacy.VerifyHashedPassword(user, hashedPassword, providedPassword);
        return legacy == PasswordVerificationResult.Success
            ? PasswordVerificationResult.SuccessRehashNeeded
            : legacy;
    }

    /// <summary>True when the PHC string's m/t/p match what we hash with today. Anything
    /// else (heavier OR lighter) is rehashed on the next successful login.</summary>
    private static bool UsesCurrentParameters(string phc)
    {
        // $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
        foreach (var field in phc.Split('$'))
        {
            if (!field.StartsWith("m=", StringComparison.Ordinal)) continue;
            var parts = field.Split(',');
            if (parts.Length < 3) return false;
            return TryParam(parts[0], "m=", out var m)
                   && TryParam(parts[1], "t=", out var t)
                   && TryParam(parts[2], "p=", out var p)
                   && m == MemoryKib && t == TimeCost && p == Parallelism;
        }
        return false; // no parameter block → treat as stale and rehash
    }

    private static bool TryParam(string field, string prefix, out int value)
    {
        value = 0;
        return field.StartsWith(prefix, StringComparison.Ordinal)
               && int.TryParse(field.AsSpan(prefix.Length), out value);
    }
}
