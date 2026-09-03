using System.Security.Cryptography;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Notifications;
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
    IRateLimiter limiter,
    IPartialAuthStore partialStore,
    IEmailSender emailSender) : IRequestHandler<LoginCommand, AuthResult>
{
    public async Task<AuthResult> Handle(LoginCommand cmd, CancellationToken ct)
    {
        var email = (cmd.Email ?? string.Empty).Trim();
        if (email.Length == 0 || string.IsNullOrEmpty(cmd.Password))
            throw DomainException.InvalidInput("email and password are required");

        var ip = cmd.Ip;
        var lockKey = "login_lock:" + ip;
        if (limiter.IsLockedOut(lockKey))
            throw DomainException.RateLimited("account temporarily locked due to too many failed attempts");

        var user = await userManager.FindByEmailAsync(email);
        // A soft-deleted account behaves as if it does not exist (generic invalid-credentials path).
        if (user is not null && user.Deleted) user = null;
        var failKey = "login_fail:" + ip;

        // Identity account lockout (per-user, 7 failed attempts) on top of the IP limiter.
        if (user is not null && await userManager.IsLockedOutAsync(user))
            throw DomainException.RateLimited("account temporarily locked due to too many failed attempts");

        if (user is null || !await userManager.CheckPasswordAsync(user, cmd.Password))
        {
            if (user is not null) await userManager.AccessFailedAsync(user);
            if (!limiter.Allow(failKey, 9, TimeSpan.FromMinutes(15)))
                limiter.Lockout(lockKey, TimeSpan.FromMinutes(15));
            throw DomainException.Unauthorized("invalid credentials");
        }
        await userManager.ResetAccessFailedCountAsync(user);
        limiter.Reset(failKey);

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

        if (AuthRules.ParseBoolean(await settings.GetAsync("email_2fa", ct), false))
        {
            var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
            var partial = partialStore.IssueWithCode(user.Id, cmd.Device, ip, code);
            await emailSender.SendAsync(user.Email, "Your Outcome sign-in code",
                $"Your verification code is {code}. It expires in 10 minutes.", ct);
            await audit.AddAsync(user.Id, "login_email_otp_sent", "user", user.Id, "email 2FA code sent to " + user.Email + await CodeSuffixAsync(settings, code, ct), ct);
            return new AuthResult { PartialToken = partial, Requires2fa = true, TwoFactorMethod = "email" };
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

    /// <summary>The code itself, and only while someone has deliberately switched that on.
    /// Off — which is the default and should stay the default outside debugging — the journal
    /// still records that a code was sent and to whom. That answers "did it go out" without
    /// handing "what is it" to everyone who can read a log: the code is a short-lived key to
    /// an account, and a journal read in a browser and kept on disk is exactly the path such
    /// things leak by.</summary>
    private static async Task<string> CodeSuffixAsync(
        ISettingsRepository settings, string code, CancellationToken ct) =>
        AuthRules.ParseBoolean(await settings.GetAsync("debug_email_codes", ct), false)
            ? $" (код {code})" : string.Empty;
}
