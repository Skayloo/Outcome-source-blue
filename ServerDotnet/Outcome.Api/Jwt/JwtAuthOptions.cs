namespace Outcome.Api.Jwt;

/// <summary>
/// JWT signing/validation settings, bound from the <c>JwtAuth</c> config section
/// (overridable via <c>OUTCOME_JwtAuth__JwtKey</c> etc.). Mirrors the reference
/// project's <c>JwtAuthSettings</c>.
/// </summary>
public sealed class JwtAuthOptions
{
    /// <summary>HMAC-SHA256 signing key. Must be at least 32 bytes. Regenerate per deployment.</summary>
    public string JwtKey { get; set; } = "";

    /// <summary>Token issuer (also used as the audience).</summary>
    public string JwtIssuer { get; set; } = "outcome";

    /// <summary>Token lifetime in minutes (default 30 days).</summary>
    public int JwtExpirationMinutes { get; set; } = 43200;
}
