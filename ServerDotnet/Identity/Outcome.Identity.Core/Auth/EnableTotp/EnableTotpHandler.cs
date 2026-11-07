using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class EnableTotpHandler(
    IUserRepository users, UserManager<User> userManager, ITotpService totp, IPendingTotpStore pending)
    : IRequestHandler<EnableTotpCommand, TotpEnableResult>
{
    public async Task<TotpEnableResult> Handle(EnableTotpCommand cmd, CancellationToken ct)
    {
        var user = await users.GetByIdAsync(cmd.UserId, ct) ?? throw DomainException.Unauthorized("not authenticated");
        await RequirePasswordAsync(userManager, user, cmd.LoginKey);

        var secret = totp.GenerateSecret();
        pending.Put(user.Id, secret);
        return new TotpEnableResult(totp.BuildUri(user.Username, secret, "Outcome"), []);
    }

    /// <summary>The current password's login key (LoginKeys), or a 400 — never 401, which the web
    /// client reads as "signed out". A re-hash Verify may make is left for the next sign-in.</summary>
    internal static Task RequirePasswordAsync(UserManager<User> userManager, User user, string loginKey)
    {
        if (string.IsNullOrEmpty(loginKey)) throw DomainException.InvalidInput("password is required");
        if (!LoginKeyAuth.Verify(user, loginKey, userManager.PasswordHasher))
            throw DomainException.InvalidInput("password confirmation failed");
        return Task.CompletedTask;
    }
}
