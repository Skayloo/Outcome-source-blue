using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class ResetPasswordHandler(
    UserManager<User> userManager,
    IPasswordResetStore resetStore,
    IJwtTokenService jwt,
    ISessionRepository sessions,
    IAuditRepository audit) : IRequestHandler<ResetPasswordCommand, AuthResult>
{
    public async Task<AuthResult> Handle(ResetPasswordCommand cmd, CancellationToken ct)
    {
        var email = (cmd.Email ?? string.Empty).Trim();
        var code = (cmd.Code ?? string.Empty).Trim();

        // Validate the new password BEFORE spending the code, so a policy rejection lets the user
        // retry with the same code instead of having to request a fresh email.
        if (AuthRules.ValidatePassword(cmd.NewPassword) is { } pwErr)
            throw DomainException.BadRequest(pwErr);

        if (!resetStore.Verify(email, code))
            throw DomainException.BadRequest("invalid or expired reset code");

        // Fetch THROUGH the UserManager (not the repo): RemovePassword/AddPassword below mutate
        // the UserManager's own tracked instance, and a second instance of the same user from the
        // repo would collide in the shared DbContext ("entity ... already being tracked").
        var user = await userManager.FindByEmailAsync(email)
                   ?? throw DomainException.BadRequest("invalid or expired reset code");

        // A forgot-password reset has no "current password" — RemovePassword + AddPassword sets one
        // regardless of prior state (an SSO-only account has only a random password it never knew).
        // GeneratePasswordResetToken is NOT used: AddIdentityCore ships no token providers here.
        if (await userManager.HasPasswordAsync(user))
        {
            var removed = await userManager.RemovePasswordAsync(user);
            if (!removed.Succeeded)
                throw DomainException.BadRequest(string.Join("; ", removed.Errors.Select(e => e.Description)));
        }
        var added = await userManager.AddPasswordAsync(user, cmd.NewPassword);
        if (!added.Succeeded)
            throw DomainException.BadRequest(string.Join("; ", added.Errors.Select(e => e.Description)));

        // Now they know a password of their own — password-shaped flows (change password, E2EE
        // backup wrapped by the password) become available.
        if (!user.PasswordSet)
        {
            user.PasswordSet = true;
            await userManager.UpdateAsync(user);
        }

        // A reset is the recovery path for an account somebody else got into: whatever sessions
        // that somebody opened have to die here, or the new password changes nothing for them.
        // Before the new one is issued, so the fresh session survives.
        await sessions.DeleteAllForUserAsync(user.Id, ct);

        // Log them straight in, like the email-OTP verify path — no second trip to the login form.
        var token = jwt.Issue(user.Id);
        await SessionIssuer.RecordAsync(sessions, jwt, user.Id, token, cmd.Device, cmd.Ip, ct);
        await audit.AddAsync(user.Id, "password_reset", "user", user.Id, "password reset via emailed code", ct);
        return new AuthResult { Token = token, Requires2fa = false, User = UserMapper.ToDto(user) };
    }
}
