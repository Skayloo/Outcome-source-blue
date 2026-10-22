using System.IdentityModel.Tokens.Jwt;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Api.Jwt;

/// <summary>
/// Registers JWT bearer authentication using <c>Microsoft.AspNetCore.Authentication.JwtBearer</c>,
/// mirroring the reference project's <c>AddJwtAuthentification</c>.
/// </summary>
public static class JwtAuthServiceCollectionExtensions
{
    public static IServiceCollection AddJwtAuthentication(this IServiceCollection services, IConfiguration configuration, bool isDevelopment = false)
    {
        services.Configure<JwtAuthOptions>(configuration.GetSection("JwtAuth"));
        // Scoped: a token is minted for, and only valid in, the request's space.
        services.AddScoped<IJwtTokenService, JwtTokenService>();

        var jwtKey = configuration["JwtAuth:JwtKey"]
                     ?? throw new InvalidOperationException("JwtAuth:JwtKey is not configured.");
        RejectAKeyEverybodyHas(jwtKey, isDevelopment);
        var issuer = configuration["JwtAuth:JwtIssuer"] ?? "outcome";

        // Keep JWT claim types verbatim (e.g. "nameid" stays "nameid" rather than being
        // remapped to the long XML-schema URI).
        JwtSecurityTokenHandler.DefaultInboundClaimTypeMap.Clear();

        services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
            })
            .AddJwtBearer(cfg =>
            {
                cfg.RequireHttpsMetadata = false;
                cfg.SaveToken = true;
                cfg.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidIssuer = issuer,
                    ValidAudience = issuer,
                    ValidateLifetime = true,
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
                    ClockSkew = TimeSpan.FromSeconds(30),
                    // Pin the algorithm: reject tokens signed with anything but HS256
                    // (blocks "alg:none" and algorithm-confusion forgery attempts).
                    ValidAlgorithms = new[] { SecurityAlgorithms.HmacSha256 },
                };
            });

        return services;
    }

    /// <summary>
    /// Refuse to start on a signing key that is not this deployment's own.
    ///
    /// This key signs session tokens, and the expiring file URLs. It sat as a
    /// literal in the repository's docker-compose.yml — the file the README's quick start tells
    /// people to run — so every install that followed the documented path shared one published
    /// key. Shipping a placeholder that silently works is how that happens; refusing to boot is
    /// the only version of this check that cannot be ignored.
    /// </summary>
    private static void RejectAKeyEverybodyHas(string key, bool isDevelopment)
    {
        // The literal that was published in docker-compose.yml, and the shape of every
        // placeholder in .env.example / deploy/k8s.
        const string published = "ae95a466fe9ea37bac64a27f34e7663377b5b275a8efc37a21c97b1b5b219c4b";
        // appsettings.json's own, for `dotnet run`: it is in every copy of the source, so outside
        // Development a deployment that forgot OUTCOME_JwtAuth__JwtKey ran on it — anyone could
        // mint a session for any user. ("change-me" with a hyphen slipped past the check below.)
        const string devOnly = "dev-only-change-me-outcome-jwt-signing-key-min-32-bytes-0123456789";
        if (key == devOnly && !isDevelopment)
            throw new InvalidOperationException(
                "JwtAuth:JwtKey is the development key from appsettings.json. Set OUTCOME_JwtAuth__JwtKey: openssl rand -hex 32");
        if (key == published || key.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                "JwtAuth:JwtKey is still the example value. Generate one: openssl rand -hex 32");
        // HS256 below 256 bits is weaker than the hash it feeds; the SDK allows 128 and this
        // does not.
        if (Encoding.UTF8.GetByteCount(key) < 32)
            throw new InvalidOperationException(
                "JwtAuth:JwtKey must be at least 32 bytes. Generate one: openssl rand -hex 32");
    }
}
