using MediatR;
using Outcome.Application.Auth;
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

        LoginKeys.RefuseRawPassword(cmd.CurrentPassword);
        LoginKeys.RefuseRawPassword(cmd.NewPassword);
        var credential = LoginKeys.Validate(cmd.Credential);

        if (!user.PasswordSet)
        {
            // Setting the FIRST password: there is no current one to prove — the row holds a
            // random string the account holder has never seen. The live session is the
            // credential, and it is the same one that would authorise changing the password.
            // Replace it outright rather than going through a reset token: this project never
            // registers Identity's token providers, so GeneratePasswordResetTokenAsync throws
            // "No IUserTwoFactorTokenProvider named 'Default' is registered" — a 500 in the
            // face of anyone setting their first password.
            LoginKeyAuth.Set(user, credential, userManager.PasswordHasher);

            user.PasswordSet = true;
            if (!(await userManager.UpdateAsync(user)).Succeeded)
                throw DomainException.BadRequest("could not set the password");
            await audit.AddAsync(cmd.UserId, "password_set", "user", cmd.UserId, "first password", ct);
            return;
        }

        // An account that has not moved to login v2 has no login key to prove yet: the client moves
        // it first (POST /auth/upgrade), so a false here is simply the wrong password.
        if (!LoginKeyAuth.Verify(user, cmd.CurrentLoginKey, userManager.PasswordHasher))
            throw DomainException.BadRequest("current password is incorrect");
        LoginKeyAuth.Set(user, credential, userManager.PasswordHasher);
        if (!(await userManager.UpdateAsync(user)).Succeeded)
            throw DomainException.BadRequest("could not change the password");

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
