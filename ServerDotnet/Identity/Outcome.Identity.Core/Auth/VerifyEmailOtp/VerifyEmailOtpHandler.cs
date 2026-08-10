using System.Security.Cryptography;
using System.Text;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class VerifyEmailOtpHandler(
    IUserRepository users,
    IPartialAuthStore partialStore,
    IJwtTokenService jwt,
    ISessionRepository sessions) : IRequestHandler<VerifyEmailOtpCommand, AuthResult>
{
    public async Task<AuthResult> Handle(VerifyEmailOtpCommand cmd, CancellationToken ct)
    {
        var challenge = partialStore.Lookup(cmd.PartialToken)
                        ?? throw DomainException.Unauthorized("invalid or expired verification challenge");

        // A challenge without a stored code is a TOTP challenge — wrong endpoint.
        if (challenge.Code is null)
            throw DomainException.Unauthorized("invalid or expired verification challenge");

        var submitted = (cmd.Code ?? string.Empty).Trim();
        if (!FixedTimeEquals(challenge.Code, submitted))
        {
            partialStore.RegisterFailure(cmd.PartialToken, 5);
            throw DomainException.Unauthorized("invalid verification code");
        }

        partialStore.Consume(cmd.PartialToken);

        var user = await users.GetByIdAsync(challenge.UserId, ct)
                   ?? throw DomainException.Unauthorized("invalid or expired verification challenge");

        var token = jwt.Issue(user.Id);
        await Outcome.Application.Common.SessionIssuer.RecordAsync(sessions, jwt, user.Id, token, challenge.Device, challenge.Ip, ct);
        return new AuthResult { Token = token, Requires2fa = false, User = UserMapper.ToDto(user) };
    }

    private static bool FixedTimeEquals(string a, string b)
    {
        var ba = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return ba.Length == bb.Length && CryptographicOperations.FixedTimeEquals(ba, bb);
    }
}
