using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class ConfirmTotpHandler(
    IUserRepository users, UserManager<User> userManager, ITotpService totp, IPendingTotpStore pending)
    : IRequestHandler<ConfirmTotpCommand>
{
    public async Task Handle(ConfirmTotpCommand cmd, CancellationToken ct)
    {
        var user = await users.GetByIdAsync(cmd.UserId, ct) ?? throw DomainException.Unauthorized("not authenticated");
        await EnableTotpHandler.RequirePasswordAsync(userManager, user, cmd.Password);

        var secret = pending.Get(user.Id) ?? throw DomainException.BadRequest("no pending two-factor enrollment found");
        if (!totp.Verify(secret, (cmd.Code ?? string.Empty).Trim(), DateTime.UtcNow))
            throw DomainException.Unauthorized("invalid two-factor code");

        await users.UpdateTotpSecretAsync(user.Id, secret, ct);
        pending.Delete(user.Id);
    }
}
