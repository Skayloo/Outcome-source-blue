using System.Security.Cryptography;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Auth;

public sealed class OAuthLoginCommandHandler(
    UserManager<User> userManager,
    ISettingsRepository settings,
    IUserRepository users,
    IAuditRepository audit,
    IJwtTokenService jwt,
    ISessionRepository sessions) : IRequestHandler<OAuthLoginCommand, AuthResult>
{
    public async Task<AuthResult> Handle(OAuthLoginCommand cmd, CancellationToken ct)
    {
        var email = cmd.Email.Trim();
        if (email.Length == 0 || AuthRules.ValidateEmail(email) is not null)
            throw DomainException.InvalidInput("the identity provider returned no usable email");

        var user = await userManager.FindByEmailAsync(email);
        if (user is not null && user.Deleted) user = null;

        if (user is null)
        {
            // First SSO visit → a fresh account. The admin's registration switches still rule:
            // SSO must not become a side door into a closed or invite-only instance (the provider
            // callback has no invite field, so invite-only simply blocks NEW SSO accounts —
            // existing ones keep signing in).
            if (!AuthRules.ParseBoolean(await settings.GetAsync("registration_open", ct), false))
                throw DomainException.Forbidden("registration is currently closed");
            if (AuthRules.ParseBoolean(await settings.GetAsync("registration_invite_only", ct), false))
                throw DomainException.Forbidden("registration requires an invite — sign up with an invite code first");

            var username = await PickFreeUsernameAsync(cmd.DisplayName, email, ct);
            // PasswordSet = false: the random password below is not something they know, so the
            // E2EE key backup cannot be wrapped with it — this account needs a backup passphrase.
            user = new User { UserName = username, Email = email, RoleId = DefaultRole.Member, Status = "offline", EmailConfirmed = true, PasswordSet = false };
            // SSO accounts get an unguessable random password: the normal password form
            // can't be used to hijack them, while every password-shaped code path keeps working.
            var created = await userManager.CreateAsync(user, RandomPassword());
            if (!created.Succeeded)
                throw DomainException.Server("could not create the account");
            await audit.AddAsync(user.Id, "user_register", "user", user.Id, $"new account via {cmd.Provider} sso", ct);
        }
        else if (IsEffectivelyBanned(user))
        {
            await audit.AddAsync(user.Id, "login_blocked_banned", "user", user.Id, $"banned user attempted {cmd.Provider} sso login from {cmd.Ip}", ct);
            throw DomainException.Forbidden("your account has been suspended");
        }

        // No local 2FA gate on this path: the provider has already authenticated the user
        // interactively, which is the very factor TOTP would re-check.
        var token = jwt.Issue(user.Id);
        await SessionIssuer.RecordAsync(sessions, jwt, user.Id, token, $"{cmd.Provider} sso", cmd.Ip, ct);
        await audit.AddAsync(user.Id, "user_login", "user", user.Id, $"{cmd.Provider} sso login from {cmd.Ip}", ct);

        var dto = await users.GetByIdAsync(user.Id, ct)
                  ?? throw DomainException.Server("sso login succeeded but user fetch failed");
        return new AuthResult { Token = token, Requires2fa = false, User = UserMapper.ToDto(dto) };
    }

    /// <summary>Derive a username from the provider's display name (falling back to the
    /// email's local part), sanitized to the same rules as manual registration, with a
    /// numeric suffix when taken.</summary>
    private async Task<string> PickFreeUsernameAsync(string displayName, string email, CancellationToken ct)
    {
        var raw = TextSanitizer.StripHtml(displayName).Trim();
        if (raw.Length == 0) raw = email.Split('@')[0];
        // Keep only characters the username validator accepts; collapse the rest.
        var cleaned = new string(raw.Where(c => char.IsLetterOrDigit(c) || c is '_' or '-' or '.').ToArray());
        if (cleaned.Length < 3) cleaned = "user" + cleaned;
        if (cleaned.Length > 24) cleaned = cleaned[..24];

        var candidate = cleaned;
        for (var i = 2; await users.ExistsByUsernameAsync(candidate, ct); i++)
        {
            var suffix = i.ToString();
            candidate = cleaned[..Math.Min(cleaned.Length, 24 - suffix.Length)] + suffix;
            if (i > 5000) throw DomainException.Server("could not derive a free username");
        }
        return candidate;
    }

    private static string RandomPassword()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        // Mixed classes so any password policy is satisfied regardless of validator settings.
        return "Aa1!" + Convert.ToBase64String(bytes);
    }

    private static bool IsEffectivelyBanned(User u) =>
        u.Banned && (u.BanExpires is null || u.BanExpires > DateTime.UtcNow);
}
