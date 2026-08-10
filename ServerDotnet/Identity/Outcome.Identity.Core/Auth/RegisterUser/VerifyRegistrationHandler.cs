using System.Security.Cryptography;
using System.Text;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Auth;

public sealed class VerifyRegistrationHandler(
    IPendingRegistrationStore pendingRegs,
    IUserRepository users,
    UserManager<User> userManager,
    IInviteRepository invites,
    IServerRepository servers,
    IAuditRepository audit,
    IJwtTokenService jwt,
    ISessionRepository sessions) : IRequestHandler<VerifyRegistrationCommand, AuthResult>
{
    public async Task<AuthResult> Handle(VerifyRegistrationCommand cmd, CancellationToken ct)
    {
        var pending = pendingRegs.Lookup(cmd.PartialToken)
                      ?? throw DomainException.Unauthorized("invalid or expired registration session");

        var submitted = (cmd.Code ?? string.Empty).Trim();
        if (!FixedTimeEquals(pending.Code, submitted))
        {
            pendingRegs.RegisterFailure(cmd.PartialToken, 5);
            throw DomainException.Unauthorized("invalid verification code");
        }

        // NOT consumed yet: everything below can still fail, and burning the session there
        // would leave the user holding a correct code that answers "invalid or expired
        // registration session" forever. Consumed once the account actually exists.

        // The world may have moved during the wait: the name/email could be taken now, and
        // the invite could have expired or run out of uses. Everything re-checks here.
        if (await users.ExistsByEmailAsync(pending.Email, ct))
            throw new DomainException("EMAIL_TAKEN", 400, "an account with this email already exists");
        if (await users.ExistsByUsernameAsync(pending.Username, ct))
            throw new DomainException("USERNAME_TAKEN", 400, "this username is already taken");

        Invite? invite = null;
        if (pending.InviteCode.Length > 0)
        {
            invite = await invites.GetByCodeAsync(pending.InviteCode, ct);
            if (invite is null
                || invite.Revoked
                || (invite.ExpiresAt is { } exp && exp <= DateTime.UtcNow)
                || (invite.MaxUses is { } max && invite.UseCount >= max))
                throw DomainException.InvalidInput("invalid or expired invite");
        }

        // The password was hashed when the registration was parked (the plaintext never
        // reached the store), so the user is created with the hash preset — password
        // validators already ran on the original submit.
        var newUser = new User
        {
            UserName = pending.Username,
            Email = pending.Email,
            RoleId = DefaultRole.Member,
            Status = "offline",
            EmailConfirmed = true, // literally what this flow just proved
            PasswordHash = pending.PasswordHash,
        };
        var created = await userManager.CreateAsync(newUser);
        if (!created.Succeeded)
        {
            // The mailbox is already proven at this point, so there is nothing left to hide:
            // say what actually blocked the account instead of a generic credential error.
            var why = string.Join("; ", created.Errors.Select(e => e.Description));
            throw new DomainException("INVALID_CREDENTIALS", 400,
                why.Length > 0 ? why : "could not create the account");
        }

        pendingRegs.Consume(cmd.PartialToken);

        return await RegistrationCompletion.FinalizeAsync(
            invites, servers, audit, jwt, sessions, users,
            newUser.Id, invite, cmd.Device, cmd.Ip, ct, cmd.HostServerId);
    }

    private static bool FixedTimeEquals(string a, string b)
    {
        var ba = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return ba.Length == bb.Length && CryptographicOperations.FixedTimeEquals(ba, bb);
    }
}
