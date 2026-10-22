using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class VerifyTotpHandler(
    IUserRepository users,
    ITotpService totp,
    IPartialAuthStore partialStore,
    IJwtTokenService jwt,
    ISessionRepository sessions) : IRequestHandler<VerifyTotpCommand, AuthResult>
{
    public async Task<AuthResult> Handle(VerifyTotpCommand cmd, CancellationToken ct)
    {
        var challenge = partialStore.Lookup(cmd.PartialToken)
                        ?? throw DomainException.Unauthorized("invalid or expired two-factor challenge");

        var user = await users.GetByIdAsync(challenge.UserId, ct);
        if (user is null || user.TotpSecret is null)
            throw DomainException.Unauthorized("invalid or expired two-factor challenge");

        if (!totp.Verify(user.TotpSecret, (cmd.Code ?? string.Empty).Trim(), DateTime.UtcNow))
        {
            partialStore.RegisterFailure(cmd.PartialToken, 5);
            throw DomainException.Unauthorized("invalid two-factor code");
        }

        partialStore.Consume(cmd.PartialToken);

        var token = jwt.Issue(user.Id);
        await Outcome.Application.Common.SessionIssuer.RecordAsync(sessions, jwt, user.Id, token, challenge.Device, challenge.Ip, ct);

        return new AuthResult { Token = token, Requires2fa = false, User = UserMapper.ToDto(user) };
    }
}
