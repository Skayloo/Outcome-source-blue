namespace Outcome.Shared.Abstractions.Security;

/// <summary>Issues and validates HS256 JWTs. The token subject is the user id.</summary>
public interface IJwtTokenService
{
    /// <summary>Issues a signed JWT whose subject (<c>nameid</c>) is <paramref name="userId"/>.</summary>
    string Issue(long userId);

    /// <summary>Validates signature + lifetime and returns the user id, or null if invalid/expired.</summary>
    long? Validate(string token);

    /// <summary>Lifetime of issued tokens — sessions created alongside a token share this expiry.</summary>
    TimeSpan TokenLifetime { get; }
}

/// <summary>SHA-256 hex hash of a raw bearer token — the key under which sessions are stored,
/// so the database never holds usable tokens.</summary>
public static class TokenHash
{
    public static string Sha256(string token) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token)));
}

/// <summary>In-memory sliding-window rate limiter with lockout, mirroring the Go limiter.</summary>
public interface IRateLimiter
{
    /// <summary>Records a hit; returns false once the count in the window exceeds <paramref name="limit"/>.</summary>
    bool Allow(string key, int limit, TimeSpan window);
    void Reset(string key);
    bool IsLockedOut(string key);
    void Lockout(string key, TimeSpan duration);
}

/// <summary>The authenticated principal for the current request (populated by auth middleware).</summary>
public interface ICurrentUser
{
    bool IsAuthenticated { get; }
    long UserId { get; }
    long RoleId { get; }
    /// <summary>Effective permissions as the legacy int64 bitfield (derived from the permission
    /// claims — claims are the source of truth). Used by the channel-override math + frontend.</summary>
    long Permissions { get; }
    /// <summary>Effective permission names (claim values), claim-based like api_mobstra_analytics.</summary>
    IReadOnlyCollection<string> PermissionNames { get; }
    string? SessionTokenHash { get; }
}

/// <summary>The active server (tenant) for the current request, from the <c>X-Server-Id</c> header
/// (or the user's primary membership). Channel/role/member queries scope to this server.</summary>
public interface ICurrentServer
{
    long ServerId { get; }
}

/// <summary>TOTP (RFC 6238) secret generation, otpauth URI building and code verification.</summary>
public interface ITotpService
{
    string GenerateSecret();
    string BuildUri(string username, string secret, string issuer);
    bool Verify(string secret, string code, DateTime atUtc);
}

/// <summary>Short-lived store of in-progress TOTP enrollments (secret pending confirmation), keyed by user.</summary>
public interface IPendingTotpStore
{
    void Put(long userId, string secret);
    string? Get(long userId);
    void Delete(long userId);
}

/// <summary>A pending 2FA challenge issued at login. <see cref="Code"/> is the expected
/// email-OTP code, or null for an authenticator (TOTP) challenge.</summary>
public sealed record PartialChallenge(long UserId, string? Device, string Ip, string? Code = null);

/// <summary>Short-lived store of partial 2FA challenges (TTL 10 min, 5-attempt budget).</summary>
public interface IPartialAuthStore
{
    string Issue(long userId, string? device, string ip);
    /// <summary>Issues a challenge carrying an expected email-OTP <paramref name="code"/>.</summary>
    string IssueWithCode(long userId, string? device, string ip, string code);
    PartialChallenge? Lookup(string partialToken);
    PartialChallenge? Consume(string partialToken);
    void RegisterFailure(string partialToken, int maxFailures);
}

/// <summary>Short-lived store of password-reset codes, keyed by email (TTL 10 min, 5-attempt
/// budget). Keying by email — not a token — lets the reset step take (email, code) directly, so
/// the "forgot" step can answer 200 unconditionally and never leak whether an address exists.</summary>
public interface IPasswordResetStore
{
    void Issue(string email, string code);
    /// <summary>True iff a live code for <paramref name="email"/> matches; consumes it on success,
    /// counts the miss and evicts after 5 failures otherwise.</summary>
    bool Verify(string email, string code);
}

/// <summary>
/// Turns an attachment id into the URL clients fetch it by, carrying an expiring signature.
///
/// The endpoint behind those URLs takes no session: an &lt;img src&gt; cannot send an
/// Authorization header, so the link itself has to be the credential. An unguessable id alone
/// made it a permanent one — anyone it ever reached kept access forever. A signature bounds
/// that to its lifetime, and re-reading the message mints a fresh link.
/// </summary>
public interface IFileUrlSigner
{
    /// <summary>The path a client should fetch, signature included.</summary>
    string Sign(string attachmentId);

    /// <summary>True iff the query carries a live signature for this id.</summary>
    bool Verify(string attachmentId, string? expires, string? signature);
}
