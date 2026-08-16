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

        if (!user.PasswordSet)
        {
            // Setting the FIRST password: there is no current one to prove. What sits on the row
            // is a random string minted at SSO signup that the account holder has never seen, so
            // asking for it would only make this endpoint unusable by exactly the people who
            // need it. The live session is the credential, and it is the same one that would
            // authorise changing the password anyway.
            // Replace it outright rather than going through a reset token: this project never
            // registers Identity's token providers, so GeneratePasswordResetTokenAsync throws
            // "No IUserTwoFactorTokenProvider named 'Default' is registered" — a 500 in the
            // face of anyone signing in with a provider for the first time.
            await userManager.RemovePasswordAsync(user);
            var set = await userManager.AddPasswordAsync(user, cmd.NewPassword);
            if (!set.Succeeded)
                throw DomainException.BadRequest("could not set the password");

            // Now they HAVE one they know — the E2EE backup can ride it from here on, and the
            // separate backup passphrase stops being necessary.
            user.PasswordSet = true;
            await userManager.UpdateAsync(user);
            await audit.AddAsync(cmd.UserId, "password_set", "user", cmd.UserId, "first password for an SSO account", ct);
            return;
        }

        var result = await userManager.ChangePasswordAsync(user, cmd.CurrentPassword, cmd.NewPassword);
        if (!result.Succeeded)
            throw DomainException.BadRequest("current password is incorrect");

        await audit.AddAsync(cmd.UserId, "password_change", "user", cmd.UserId, string.Empty, ct);
    }
}
