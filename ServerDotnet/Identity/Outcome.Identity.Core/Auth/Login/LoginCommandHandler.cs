using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class LoginCommandHandler(
    UserManager<User> userManager,
    ISettingsRepository settings,
    IAuditRepository audit,
    IJwtTokenService jwt,
    ISessionRepository sessions,
    IPartialAuthStore partialStore) : IRequestHandler<LoginCommand, AuthResult>
{
    public async Task<AuthResult> Handle(LoginCommand cmd, CancellationToken ct)
    {
        LoginKeys.RefuseRawPassword(cmd.Password);
        var email = (cmd.Email ?? string.Empty).Trim();
        if (email.Length == 0 || (string.IsNullOrEmpty(cmd.LoginKey) && string.IsNullOrEmpty(cmd.LegacyProof)))
            throw DomainException.InvalidInput("email and password are required");
        // An account made before login v2 moves on this sign-in: a malformed credential is a client
        // bug, answered before anything is looked up.
        var moving = string.IsNullOrEmpty(cmd.LoginKey) ? LoginKeys.Validate(cmd.Credential) : null;

        var ip = cmd.Ip;

        var user = await userManager.FindByEmailAsync(email);
        // A soft-deleted account behaves as if it does not exist (generic invalid-credentials path).
        if (user is not null && user.Deleted) user = null;

        // There used to be a second lockout here, keyed on the client IP: nine failed attempts
        // and that address was refused for fifteen minutes. Behind a router that rewrites the
        // source address every visitor shares one address, so nine wrong passwords by anyone
        // locked EVERY user out of the product — and each further wrong password re-armed it,
        // while a successful login never cleared it. It was also redundant: the per-user lockout
        // below is the protection that actually matters, because brute force targets an account,
        // not an address. See the ClientRate notes for why an address means nothing here.
        //
        // Per-user lockout (Identity, 7 failed attempts):
        if (user is not null && await userManager.IsLockedOutAsync(user))
            throw DomainException.RateLimited("account temporarily locked due to too many failed attempts");

        var hasher = userManager.PasswordHasher;
        var hashBefore = user?.AuthHash;
        var opened = user is not null && (moving is null
            ? LoginKeyAuth.Verify(user, cmd.LoginKey, hasher)
            : LoginKeyAuth.TryMove(user, cmd.LegacyProof, moving, hasher));
        if (user is null || !opened)
        {
            if (user is not null) await userManager.AccessFailedAsync(user);
            throw DomainException.Unauthorized("invalid credentials");
        }
        // Only a move or a re-hash changes the row, and only then is it saved. Saving it on EVERY
        // sign-in made two sign-ins of one account in the same moment collide on the concurrency
        // stamp: the loser's UpdateAsync failed quietly, its session insert then saved the stale user
        // again and the whole sign-in answered 500 (production, 2026-11-07 — voice.mjs signs one QA
        // account into two browsers at once; a person on two devices hits it too).
        if (moving is not null || user.AuthHash != hashBefore) await userManager.UpdateAsync(user);
        await userManager.ResetAccessFailedCountAsync(user); // a no-op at zero, as before login v2
        if (moving is not null)
            await audit.AddAsync(user.Id, "login_key_set", "user", user.Id, "moved to sign-in without the password", ct);

        if (IsEffectivelyBanned(user))
        {
            await audit.AddAsync(user.Id, "login_blocked_banned", "user", user.Id, "banned user attempted login from " + ip, ct);
            throw DomainException.Forbidden("your account has been suspended");
        }

        var require2fa = AuthRules.ParseBoolean(await settings.GetAsync("require_2fa", ct), false);

        if (user.TotpSecret is not null)
        {
            var partial = partialStore.Issue(user.Id, cmd.Device, ip);
            return new AuthResult { PartialToken = partial, Requires2fa = true, TwoFactorMethod = "totp" };
        }

        if (require2fa)
            throw DomainException.Forbidden("two-factor authentication must be enabled on this account before login");

        var token = jwt.Issue(user.Id);
        await SessionIssuer.RecordAsync(sessions, jwt, user.Id, token, cmd.Device, ip, ct);
        await audit.AddAsync(user.Id, "user_login", "user", user.Id, "logged in from " + ip, ct);

        return new AuthResult { Token = token, Requires2fa = false, User = UserMapper.ToDto(user) };
    }

    private static bool IsEffectivelyBanned(User u) =>
        u.Banned && (u.BanExpires is null || u.BanExpires > DateTime.UtcNow);

}
