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
    public static IServiceCollection AddJwtAuthentication(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<JwtAuthOptions>(configuration.GetSection("JwtAuth"));
        // Scoped: a token is minted for, and only valid in, the request's space.
        services.AddScoped<IJwtTokenService, JwtTokenService>();

        var jwtKey = configuration["JwtAuth:JwtKey"]
                     ?? throw new InvalidOperationException("JwtAuth:JwtKey is not configured.");
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
}
