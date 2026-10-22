using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;
using Outcome.Shared.Legal;

namespace Outcome.Application.Auth;

public sealed class RegisterUserHandler(
    ISettingsRepository settings,
    IUserRepository users,
    UserManager<User> userManager,
    IInviteRepository invites,
    IServerRepository servers,
    IAuditRepository audit,
    IJwtTokenService jwt,
    ISessionRepository sessions) : IRequestHandler<RegisterUserCommand, AuthResult>
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

        // Recorded at creation, never updated: this is what THIS person agreed to when
        // they signed up, not what the current text happens to say.
        var newUser = new User
        {
            UserName = username, Email = email, RoleId = DefaultRole.Member,
            Status = "offline", EmailConfirmed = false,
            ConsentAt = DateTime.UtcNow,
            ConsentVersion = string.IsNullOrWhiteSpace(cmd.ConsentVersion) ? PdnConsent.Version : cmd.ConsentVersion,
        };
        var created = await userManager.CreateAsync(newUser, cmd.Password);
        if (!created.Succeeded)
            throw GenericAuthError();

        return await RegistrationCompletion.FinalizeAsync(
            invites, servers, audit, jwt, sessions, users,
            newUser.Id, invite, cmd.Device, cmd.Ip, ct, cmd.HostServerId);
    }
}

/// <summary>The tail of a registration: consume the invite + join its server, audit, issue the
/// JWT, record the session.</summary>
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
            // In no server at all: give them their own (see DefaultServer). Inside the command's
            // transaction, so the account and its server exist together or not at all.
            var fresh = await users.GetByIdAsync(uid, ct)
                        ?? throw DomainException.Server("registration succeeded but user fetch failed");
            var own = await servers.CreateAsync(DefaultServer.NameFor(fresh.UserName), uid, ct);
            await audit.AddAsync(uid, "user_register", "user", uid, $"new account created (open registration), own server {own.Id}", ct);
        }

        var token = jwt.Issue(uid);
        await SessionIssuer.RecordAsync(sessions, jwt, uid, token, device, ip, ct);

        var user = await users.GetByIdAsync(uid, ct)
                   ?? throw DomainException.Server("registration succeeded but user fetch failed");

        return new AuthResult { Token = token, Requires2fa = false, User = UserMapper.ToDto(user) };
    }
}
