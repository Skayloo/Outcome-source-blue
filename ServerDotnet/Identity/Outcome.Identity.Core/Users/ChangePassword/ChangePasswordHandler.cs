using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed class ChangePasswordHandler(UserManager<User> userManager, IAuditRepository audit)
    : IRequestHandler<ChangePasswordCommand>
{
    public async Task Handle(ChangePasswordCommand cmd, CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(cmd.UserId.ToString())
                   ?? throw DomainException.Unauthorized("user not found");

        if (AuthRules.ValidatePassword(cmd.NewPassword) is { } err)
            throw DomainException.BadRequest(err);

        var result = await userManager.ChangePasswordAsync(user, cmd.CurrentPassword, cmd.NewPassword);
        if (!result.Succeeded)
            throw DomainException.BadRequest("current password is incorrect");

        // An SSO account that just chose a password now HAS one it knows — the E2EE backup can
        // ride it from here on, and the separate passphrase stops being necessary.
        if (!user.PasswordSet)
        {
            user.PasswordSet = true;
            await userManager.UpdateAsync(user);
        }

        await audit.AddAsync(cmd.UserId, "password_change", "user", cmd.UserId, string.Empty, ct);
    }
}
