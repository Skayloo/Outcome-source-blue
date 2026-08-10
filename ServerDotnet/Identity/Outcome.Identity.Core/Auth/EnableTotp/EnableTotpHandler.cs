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
        await RequirePasswordAsync(userManager, user, cmd.Password);

        var secret = totp.GenerateSecret();
        pending.Put(user.Id, secret);
        return new TotpEnableResult(totp.BuildUri(user.Username, secret, "Outcome"), []);
    }

    internal static async Task RequirePasswordAsync(UserManager<User> userManager, User user, string password)
    {
        if (string.IsNullOrEmpty(password)) throw DomainException.InvalidInput("password is required");
        if (!await userManager.CheckPasswordAsync(user, password))
            throw DomainException.InvalidInput("password confirmation failed");
    }
}
