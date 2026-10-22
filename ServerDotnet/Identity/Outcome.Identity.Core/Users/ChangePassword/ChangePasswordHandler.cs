using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed class ChangePasswordHandler(
    UserManager<User> userManager, IAuditRepository audit,
    ISessionRepository sessions, ICurrentUser current)
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
            // Setting the FIRST password: there is no current one to prove — the row holds a
            // random string the account holder has never seen. The live session is the
            // credential, and it is the same one that would authorise changing the password.
            // Replace it outright rather than going through a reset token: this project never
            // registers Identity's token providers, so GeneratePasswordResetTokenAsync throws
            // "No IUserTwoFactorTokenProvider named 'Default' is registered" — a 500 in the
            // face of anyone setting their first password.
            await userManager.RemovePasswordAsync(user);
            var set = await userManager.AddPasswordAsync(user, cmd.NewPassword);
            if (!set.Succeeded)
                throw DomainException.BadRequest("could not set the password");

            user.PasswordSet = true;
            await userManager.UpdateAsync(user);
            await audit.AddAsync(cmd.UserId, "password_set", "user", cmd.UserId, "first password", ct);
            return;
        }

        var result = await userManager.ChangePasswordAsync(user, cmd.CurrentPassword, cmd.NewPassword);
        if (!result.Succeeded)
            throw DomainException.BadRequest("current password is incorrect");

        // Changing a password is what someone does when they think somebody else has it, and a
        // password change that leaves the other party signed in does not do that job. Every other
        // session goes; this one stays, or the act of securing the account signs you out of it.
        var revoked = current.SessionTokenHash is { Length: > 0 } h
            ? await sessions.DeleteAllForUserExceptAsync(cmd.UserId, h, ct)
            : 0;

        await audit.AddAsync(cmd.UserId, "password_change", "user", cmd.UserId,
            revoked > 0 ? $"{revoked} other session(s) revoked" : string.Empty, ct);
    }
}
