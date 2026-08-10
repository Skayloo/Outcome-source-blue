using Outcome.Domain.Entities;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Application.Common;

/// <summary>
/// Persists the session row that backs a freshly issued bearer token. The row's presence is
/// what keeps the token usable — logout and admin kick delete rows, revoking the token even
/// though the JWT itself is still cryptographically valid until expiry.
/// </summary>
public static class SessionIssuer
{
    public static Task RecordAsync(
        ISessionRepository sessions, IJwtTokenService jwt, long userId, string token,
        string? device, string? ip, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        return sessions.CreateAsync(new Session
        {
            UserId = userId,
            Token = TokenHash.Sha256(token),
            Device = device,
            IpAddress = ip,
            CreatedAt = now,
            LastUsed = now,
            ExpiresAt = now.Add(jwt.TokenLifetime),
        }, ct);
    }
}
