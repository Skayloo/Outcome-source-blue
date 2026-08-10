using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class DisableTotpHandler(
    IUserRepository users, ISettingsRepository settings, UserManager<User> userManager, IPendingTotpStore pending)
    : IRequestHandler<DisableTotpCommand>
{
    public async Task Handle(DisableTotpCommand cmd, CancellationToken ct)
    {
        var user = await users.GetByIdAsync(cmd.UserId, ct) ?? throw DomainException.Unauthorized("not authenticated");
        await EnableTotpHandler.RequirePasswordAsync(userManager, user, cmd.Password);

        if (AuthRules.ParseBoolean(await settings.GetAsync("require_2fa", ct), false))
            throw DomainException.Forbidden("two-factor authentication is required for this server");

        pending.Delete(user.Id);
        await users.UpdateTotpSecretAsync(user.Id, null, ct);
    }
}
