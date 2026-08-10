using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Outcome.Shared.Abstractions.Security;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Jwt;

/// <summary>
/// Issues and validates HS256 JWTs. Identity-only tokens: the subject is the user id
/// (<c>nameid</c>/<c>sub</c>); roles and permissions are resolved fresh per request so a
/// role change takes effect immediately rather than at token expiry. Mirrors the reference
/// project's <c>JwtTokenService</c>.
/// </summary>
public sealed class JwtTokenService(IOptions<JwtAuthOptions> options, ICurrentSpace space) : IJwtTokenService
{
    public const string SpaceClaim = "spc";

    /// <summary>The space a token was issued for. Tokens minted before spaces existed carry no
    /// claim and belong to the root space — the only one there was.</summary>
    public static long SpaceOf(ClaimsPrincipal principal) =>
        long.TryParse(principal.FindFirst(SpaceClaim)?.Value, out var id) ? id : Space.RootId;

    private SymmetricSecurityKey Key() => new(Encoding.UTF8.GetBytes(options.Value.JwtKey));

    public TimeSpan TokenLifetime => TimeSpan.FromMinutes(options.Value.JwtExpirationMinutes);

    public string Issue(long userId)
    {
        var creds = new SigningCredentials(Key(), SecurityAlgorithms.HmacSha256);
        var now = DateTime.UtcNow;
        var claims = new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new Claim(JwtRegisteredClaimNames.NameId, userId.ToString()),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new Claim(JwtRegisteredClaimNames.Iat, ((DateTimeOffset)now).ToUnixTimeSeconds().ToString()),
            // The space this token belongs to. User ids are tenant-local, so without this a
            // token from one space would authenticate as whoever holds that id in another.
            new Claim(SpaceClaim, space.Space.Id.ToString()),
        };

        var token = new JwtSecurityToken(
            issuer: options.Value.JwtIssuer,
            audience: options.Value.JwtIssuer,
            claims: claims,
            notBefore: now,
            expires: now.AddMinutes(options.Value.JwtExpirationMinutes),
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public long? Validate(string token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        try
        {
            var parameters = new TokenValidationParameters
            {
                ValidIssuer = options.Value.JwtIssuer,
                ValidAudience = options.Value.JwtIssuer,
                ValidateLifetime = true,
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = Key(),
                ClockSkew = TimeSpan.FromSeconds(30),
            };

            var principal = new JwtSecurityTokenHandler().ValidateToken(token, parameters, out _);
            if (SpaceOf(principal) != space.Space.Id) return null;
            var id = principal.FindFirst(JwtRegisteredClaimNames.NameId)?.Value
                     ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            return long.TryParse(id, out var uid) ? uid : null;
        }
        catch
        {
            return null;
        }
    }
}
