using System.Security.Cryptography;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Auth;

public sealed class RegisterUserHandler(
    ISettingsRepository settings,
    IUserRepository users,
    UserManager<User> userManager,
    IInviteRepository invites,
    IServerRepository servers,
    IAuditRepository audit,
    IJwtTokenService jwt,
    ISessionRepository sessions,
    IPendingRegistrationStore pendingRegs,
    IEmailSender emailSender,
    IRateLimiter limiter) : IRequestHandler<RegisterUserCommand, AuthResult>
{
    // Generic failure (avoids revealing whether the invite or the username was the problem).
    private static DomainException GenericAuthError() =>
        new("INVALID_CREDENTIALS", 400, "invalid invite or credentials");

    public async Task<AuthResult> Handle(RegisterUserCommand cmd, CancellationToken ct)
    {
        if (!AuthRules.ParseBoolean(await settings.GetAsync("registration_open", ct), false))
            throw DomainException.Forbidden("registration is currently closed");
        if (AuthRules.ParseBoolean(await settings.GetAsync("require_2fa", ct), false))
            throw DomainException.Forbidden("registration is unavailable while two-factor authentication is required");

        var email = (cmd.Email ?? string.Empty).Trim();
        var username = TextSanitizer.StripHtml(cmd.Username);
        var inviteCode = (cmd.InviteCode ?? string.Empty).Trim();
        if (email.Length == 0 || username.Length == 0 || string.IsNullOrEmpty(cmd.Password))
            throw DomainException.InvalidInput("email, username, and password are required");

        if (AuthRules.ValidateEmail(email) is { } emailErr)
            throw DomainException.InvalidInput(emailErr);
        if (AuthRules.ValidateUsername(username) is { } unameErr)
            throw DomainException.InvalidInput(unameErr);
        if (AuthRules.ValidatePassword(cmd.Password) is { } pwErr)
            throw DomainException.InvalidInput(pwErr);

        // Invite policy is a runtime switch: normally an invite is OPTIONAL (with one the account
        // joins that server, without one it's standalone), but the admin can flip the instance to
        // invite-only — the launch-wave throttle: growth pauses instead of the service falling over.
        if (AuthRules.ParseBoolean(await settings.GetAsync("registration_invite_only", ct), false)
            && inviteCode.Length == 0)
            throw DomainException.Forbidden("an invite code is required to register");

        Invite? invite = null;
        if (inviteCode.Length > 0)
        {
            invite = await invites.GetByCodeAsync(inviteCode, ct);
            if (invite is null
                || invite.Revoked
                || (invite.ExpiresAt is { } exp && exp <= DateTime.UtcNow)
                || (invite.MaxUses is { } max && invite.UseCount >= max))
                throw DomainException.InvalidInput("invalid or expired invite");
        }

        if (await users.ExistsByEmailAsync(email, ct))
            throw new DomainException("EMAIL_TAKEN", 400, "an account with this email already exists");
        if (await users.ExistsByUsernameAsync(username, ct))
            throw new DomainException("USERNAME_TAKEN", 400, "this username is already taken");

        // Anti-abuse chokepoint: with the switch on, NOTHING touches the users table until a
        // code sent to the mailbox round-trips (see VerifyRegistrationHandler) — a bot without
        // a real inbox never creates a row. The password is hashed HERE so the plaintext never
        // sits in the pending store, and the invite is only consumed on completion.
        if (AuthRules.ParseBoolean(await settings.GetAsync("registration_email_verify", ct), false))
        {
            // Per-address send budget — otherwise re-submitting the form bombs a victim's inbox.
            if (!limiter.Allow($"regmail:{email}", 3, TimeSpan.FromMinutes(15)))
                throw new DomainException("RATE_LIMITED", 429, "too many codes sent to this email, please try again later");

            var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
            var hash = userManager.PasswordHasher.HashPassword(
                new User { UserName = username }, cmd.Password);
            var pendingToken = pendingRegs.Issue(
                new PendingRegistration(email, username, hash, inviteCode, cmd.Device, cmd.Ip, code));
            await emailSender.SendAsync(email, "Your Outcome registration code",
                $"Your verification code is {code}. It expires in 10 minutes.", ct);
            await audit.AddAsync(0, "register_email_code_sent", "user", 0, $"registration code sent to {email}", ct);
            return new AuthResult { PartialToken = pendingToken, RequiresEmailVerify = true };
        }

        var newUser = new User { UserName = username, Email = email, RoleId = DefaultRole.Member, Status = "offline", EmailConfirmed = true };
        var created = await userManager.CreateAsync(newUser, cmd.Password);
        if (!created.Succeeded)
            throw GenericAuthError();

        return await RegistrationCompletion.FinalizeAsync(
            invites, servers, audit, jwt, sessions, users,
            newUser.Id, invite, cmd.Device, cmd.Ip, ct, cmd.HostServerId);
    }
}

/// <summary>The shared tail of both registration paths (immediate and email-verified):
/// consume the invite + join its server, audit, issue the JWT, record the session.</summary>
internal static class RegistrationCompletion
{
    public static async Task<AuthResult> FinalizeAsync(
        IInviteRepository invites, IServerRepository servers, IAuditRepository audit,
        IJwtTokenService jwt, ISessionRepository sessions, IUserRepository users,
        long uid, Invite? invite, string? device, string? ip, CancellationToken ct,
        long? hostServerId = null)
    {
        if (invite is not null)
        {
            await invites.ConsumeAsync(invite.Id, uid, ct);
            await servers.AddMemberAsync(invite.ServerId, uid, null, ct);
            await audit.AddAsync(uid, "user_register", "user", uid, "new account created via invite", ct);
        }
        else if (hostServerId is { } spaceId)
        {
            await servers.AddMemberAsync(spaceId, uid, null, ct);
            await audit.AddAsync(uid, "user_register", "user", uid, $"new account created on the space's own domain (server {spaceId})", ct);
        }
        else
        {
            await audit.AddAsync(uid, "user_register", "user", uid, "new account created (open registration)", ct);
        }

        var token = jwt.Issue(uid);
        await SessionIssuer.RecordAsync(sessions, jwt, uid, token, device, ip, ct);

        var user = await users.GetByIdAsync(uid, ct)
                   ?? throw DomainException.Server("registration succeeded but user fetch failed");

        return new AuthResult { Token = token, Requires2fa = false, User = UserMapper.ToDto(user) };
    }
}
