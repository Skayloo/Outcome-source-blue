using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Outcome.Domain.Errors;

namespace Outcome.Shared.Abstractions.Security;

/// <summary>
/// What a client sends when it SETS a password: a salt it drew itself, the PBKDF2 iteration count
/// it used, and the login key that came out (all base64). The password itself never travels.
/// </summary>
public sealed record LoginCredential(string? Salt, int Iterations, string? Key);

/// <summary>
/// Sign-in without the password ("login v2"). The client turns the password into a login key on
/// the device and sends only that:
/// <code>
///   master    = PBKDF2-HMAC-SHA256(utf8(password), salt, iterations)   → 32 bytes
///   login key = HKDF-SHA256(ikm = master, salt = empty, info = "outcome/login/v2") → 32 bytes
/// </code>
/// and the server keeps the account's salt and iteration count plus its usual Argon2id hash of
/// the login key. Nothing that reaches the server lets it recompute the password, so anything a
/// client derives from the password for its own use stays out of the server's reach.
///
/// The same constants live in the web client (lib/loginKey.ts), the app (services/login_key.dart)
/// and tools/LoginKeyCheck, which checks all of them against one set of vectors.
/// </summary>
public static class LoginKeys
{
    /// <summary>What clients use today when they set a password.</summary>
    public const int Iterations = 600_000;
    /// <summary>Clients refuse to derive with fewer — a server cannot talk them into a cheap key.</summary>
    public const int MinIterations = 600_000;
    /// <summary>…or with absurdly many (a hostile server freezing the sign-in screen).</summary>
    public const int MaxIterations = 5_000_000;
    public const int SaltBytes = 16;
    public const int KeyBytes = 32;
    public static readonly byte[] Info = "outcome/login/v2"u8.ToArray();

    /// <summary>The answer to a client that still sends the password itself. 400, never 401: the
    /// web client treats any 401 as an expired session and signs out.</summary>
    public static DomainException UpdateRequired() =>
        new("CLIENT_UPDATE_REQUIRED", 400, "this version of the app is out of date, update it to sign in");

    /// <summary>A request carrying a password is from a client older than login v2: refused, so
    /// the password stops reaching the server the day this ships, not when old apps die out.</summary>
    public static void RefuseRawPassword(string? password)
    {
        if (!string.IsNullOrEmpty(password)) throw UpdateRequired();
    }

    /// <summary>A credential in canonical form, ready to store.</summary>
    public sealed record Valid(string Salt, int Iterations, string Key);

    /// <summary>Checks a credential's shape: 16-byte salt, iterations within bounds, 32-byte key.
    /// The password's own rules (length, a digit) cannot be checked here any more — the server
    /// never sees it — so the clients check them.</summary>
    public static Valid Validate(LoginCredential? c)
    {
        if (c is null) throw DomainException.InvalidInput("credential is required");
        var salt = Decode(c.Salt, SaltBytes) ?? throw DomainException.InvalidInput("invalid credential salt");
        if (c.Iterations < MinIterations || c.Iterations > MaxIterations)
            throw DomainException.InvalidInput("invalid credential iterations");
        var key = Decode(c.Key, KeyBytes) ?? throw DomainException.InvalidInput("invalid credential key");
        return new Valid(Convert.ToBase64String(salt), c.Iterations, Convert.ToBase64String(key));
    }

    /// <summary>A login key in canonical base64, or null when it is not 32 bytes of base64.</summary>
    public static string? NormalizeKey(string? key) =>
        Decode(key, KeyBytes) is { } bytes ? Convert.ToBase64String(bytes) : null;

    /// <summary>The client's derivation, for the check tool and tests. The server never runs it:
    /// it never has a password to run it on.</summary>
    public static byte[] DeriveKey(string password, byte[] salt, int iterations)
    {
        var master = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, iterations,
            HashAlgorithmName.SHA256, KeyBytes);
        return HKDF.DeriveKey(HashAlgorithmName.SHA256, master, KeyBytes, Array.Empty<byte>(), Info);
    }

    /// <summary>
    /// The salt an unknown address is answered with: stable for that address, so asking twice
    /// tells nothing, and indistinguishable from a real one. <paramref name="secret"/> is derived
    /// from a server secret; the space is part of it because every space numbers its own users.
    /// </summary>
    public static string FakeSalt(byte[] secret, long spaceId, string email)
    {
        var mac = HMACSHA256.HashData(secret,
            Encoding.UTF8.GetBytes($"prelogin|{spaceId}|{email.Trim().ToLowerInvariant()}"));
        return Convert.ToBase64String(mac, 0, SaltBytes);
    }

    // ── accounts made before login v2 ────────────────────────────────────────────────────────

    /// <summary>
    /// How an account made before login v2 had its password hashed, so the client can compute the
    /// same hash on the device and prove it knows the password without sending it.
    /// <paramref name="Kind"/> is "argon2id" (M/T/P, the PHC salt), "pbkdf2" (Identity V3: Prf
    /// sha256|sha512, Iterations, salt) or "unsupported" (anything too weak to ask a client for —
    /// a hostile server would use it to get a cheap hash of the password; such an account resets
    /// its password by mail).
    /// </summary>
    public sealed record Legacy(
        string Kind, string? Salt = null, int Length = 0,
        int? M = null, int? T = null, int? P = null,
        string? Prf = null, int? Iterations = null);

    /// <summary>Lowest legacy parameters a client agrees to compute (and the server offers).</summary>
    public const int LegacyArgonMinMemoryKib = 19_456, LegacyArgonMinTime = 2, LegacyPbkdf2MinIterations = 100_000;

    public static Legacy DescribeLegacy(string? stored)
    {
        var parsed = ParseLegacy(stored) ?? ParseWrapped(stored)?.Parsed;
        if (parsed is null) return new Legacy("unsupported");
        var p = parsed.Value;
        return p.Kind switch
        {
            "argon2id" when p.M >= LegacyArgonMinMemoryKib && p.T >= LegacyArgonMinTime && p.P is >= 1 and <= 8
                => new Legacy("argon2id", Convert.ToBase64String(p.Salt), p.Hash.Length, M: p.M, T: p.T, P: p.P),
            "pbkdf2" when p.Iterations >= LegacyPbkdf2MinIterations && p.Prf is "sha256" or "sha512"
                => new Legacy("pbkdf2", Convert.ToBase64String(p.Salt), p.Hash.Length, Prf: p.Prf, Iterations: p.Iterations),
            _ => new Legacy("unsupported"),
        };
    }

    /// <summary>Does the client's legacy proof equal the stored PLAIN hash? Constant-time; false for
    /// anything <see cref="DescribeLegacy"/> would not have offered, and for a wrapped hash — that
    /// one is checked with the password hasher (LoginKeyAuth.LegacyMatches).</summary>
    public static bool LegacyProofMatches(string? stored, string? proof)
    {
        if (IsWrapped(stored) || DescribeLegacy(stored).Kind == "unsupported") return false;
        var parsed = ParseLegacy(stored);
        if (parsed is null) return false;
        var given = Decode(proof, parsed.Value.Hash.Length);
        return given is not null && CryptographicOperations.FixedTimeEquals(given, parsed.Value.Hash);
    }

    // ── old hashes wrapped once more (2026-11-07) ──────────────────────────────────────────────
    //
    // The proof that moves an account IS its old hash, so a plain old hash read out of the database
    // would move the account by itself, with no password guessed. Every old hash is therefore kept
    // wrapped (Program.cs, WrapLegacyHashesAsync): what the client needs to recompute it — kind,
    // parameters, salt, length — and Argon2id over the old hash made by the server's own password
    // hasher. A proof is hashed again and compared with the wrap, so nothing the database holds
    // passes as a proof any more.
    //
    //   owrap1|argon2id|<m>,<t>,<p>|<salt base64>|<length>|<Argon2id PHC of base64(old hash)>
    //   owrap1|pbkdf2|<prf>,<iterations>|<salt base64>|<length>|<the same>
    //
    // A server from before this cannot read the wrapped form: rolling back past it means a password
    // reset for every account that had not moved yet.

    public const string WrapPrefix = "owrap1|";

    public static bool IsWrapped(string? stored) => stored?.StartsWith(WrapPrefix, StringComparison.Ordinal) == true;

    /// <summary>The bytes to wrap (the old hash itself), or null for anything but a plain old hash.</summary>
    public static byte[]? LegacyHashBytes(string? stored) => ParseLegacy(stored)?.Hash;

    /// <summary>The wrapped form of a plain old hash, given the wrap made over base64 of its bytes.</summary>
    public static string? WrapLegacy(string? stored, string wrapPhc)
    {
        if (wrapPhc.Contains('|') || !wrapPhc.StartsWith("$argon2", StringComparison.Ordinal)) return null;
        if (ParseLegacy(stored) is not { } v) return null;
        var parameters = v.Kind == "argon2id" ? $"{v.M},{v.T},{v.P}" : $"{v.Prf},{v.Iterations}";
        return $"{WrapPrefix}{v.Kind}|{parameters}|{Convert.ToBase64String(v.Salt)}|{v.Hash.Length}|{wrapPhc}";
    }

    /// <summary>The wrap a proof is checked against and the old hash's length, for a wrapped hash.</summary>
    public static (string WrapPhc, int Length)? Unwrap(string? stored) =>
        ParseWrapped(stored) is { } w ? (w.WrapPhc, w.Parsed.Hash.Length) : null;

    /// <summary>A proof decoded to exactly <paramref name="length"/> bytes, or null.</summary>
    public static byte[]? DecodeProof(string? proof, int length) => Decode(proof, length);

    private static (Parsed Parsed, string WrapPhc)? ParseWrapped(string? stored)
    {
        if (!IsWrapped(stored)) return null;
        var parts = stored!.Split('|');
        if (parts.Length != 6 || !int.TryParse(parts[4], out var length) || length is < 16 or > 64) return null;
        if (!parts[5].StartsWith("$argon2", StringComparison.Ordinal)) return null;
        byte[] salt;
        try { salt = Convert.FromBase64String(parts[3]); } catch (FormatException) { return null; }
        if (salt.Length < 8) return null;
        // Only the length of the old hash is kept; a wrapped hash is never compared as bytes.
        var length0 = new byte[length];
        var ps = parts[2].Split(',');
        if (parts[1] == "argon2id" && ps.Length == 3
            && int.TryParse(ps[0], out var m) && int.TryParse(ps[1], out var t) && int.TryParse(ps[2], out var p))
            return (new Parsed("argon2id", salt, length0, m, t, p, null, 0), parts[5]);
        if (parts[1] == "pbkdf2" && ps.Length == 2 && ps[0] is "sha256" or "sha512" or "sha1"
            && int.TryParse(ps[1], out var iterations))
            return (new Parsed("pbkdf2", salt, length0, 0, 0, 0, ps[0], iterations), parts[5]);
        return null;
    }

    private readonly record struct Parsed(string Kind, byte[] Salt, byte[] Hash, int M, int T, int P, string? Prf, int Iterations);

    private static Parsed? ParseLegacy(string? stored)
    {
        if (string.IsNullOrEmpty(stored) || IsWrapped(stored)) return null;
        try
        {
            if (stored.StartsWith("$argon2id$", StringComparison.Ordinal))
            {
                // $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> (Isopoh: UTF-8 password, no secret, no AD)
                var parts = stored.Split('$');
                if (parts.Length != 6 || parts[2] != "v=19") return null;
                int m = 0, t = 0, p = 0;
                foreach (var kv in parts[3].Split(','))
                {
                    var eq = kv.IndexOf('=');
                    if (eq < 1 || !int.TryParse(kv.AsSpan(eq + 1), out var v)) return null;
                    switch (kv[..eq]) { case "m": m = v; break; case "t": t = v; break; case "p": p = v; break; default: return null; }
                }
                var salt = PhcDecode(parts[4]);
                var hash = PhcDecode(parts[5]);
                if (salt is null || hash is null || salt.Length < 8 || hash.Length is < 16 or > 64) return null;
                return new Parsed("argon2id", salt, hash, m, t, p, null, 0);
            }
            if (stored.StartsWith('$')) return null;
            // ASP.NET Core Identity V3: 0x01 | prf (u32 BE) | iterations (u32 BE) | salt length (u32 BE) | salt | subkey
            var raw = Convert.FromBase64String(stored);
            if (raw.Length < 13 || raw[0] != 0x01) return null;
            var prf = BinaryPrimitives.ReadUInt32BigEndian(raw.AsSpan(1)) switch { 1u => "sha256", 2u => "sha512", 0u => "sha1", _ => null };
            var iter = BinaryPrimitives.ReadUInt32BigEndian(raw.AsSpan(5));
            var saltLen = (int)BinaryPrimitives.ReadUInt32BigEndian(raw.AsSpan(9));
            if (prf is null || iter > int.MaxValue || saltLen < 8 || 13 + saltLen + 16 > raw.Length) return null;
            var s = raw.AsSpan(13, saltLen).ToArray();
            var k = raw.AsSpan(13 + saltLen).ToArray();
            if (k.Length is < 16 or > 64) return null;
            return new Parsed("pbkdf2", s, k, 0, 0, 0, prf, (int)iter);
        }
        catch (FormatException) { return null; }
    }

    private static byte[]? PhcDecode(string s)
    {
        // PHC strings use base64 without padding; some writers keep it.
        var t = s.TrimEnd('=');
        t += (t.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        try { return Convert.FromBase64String(t); } catch (FormatException) { return null; }
    }

    private static byte[]? Decode(string? b64, int length)
    {
        if (string.IsNullOrWhiteSpace(b64) || b64.Length > 4 * ((length + 2) / 3) + 4) return null;
        try
        {
            var bytes = Convert.FromBase64String(b64.Trim());
            return bytes.Length == length ? bytes : null;
        }
        catch (FormatException) { return null; }
    }
}
