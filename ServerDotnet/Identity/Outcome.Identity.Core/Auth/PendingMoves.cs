using Microsoft.AspNetCore.Identity;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Application.Auth;

/// <summary>
/// The second half of a sign-in that moves an account made before login v2 on a 2FA account: the
/// credential parked in the challenge (<see cref="Outcome.Shared.Abstractions.Security.PartialChallenge.PendingMove"/>)
/// becomes the account's login only once the second factor checked out.
/// </summary>
internal static class PendingMoves
{
    public static async Task ApplyAsync(UserManager<User> userManager, IAuditRepository audit, long userId, string packed,
        CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(userId.ToString())
                   ?? throw DomainException.Unauthorized("invalid or expired two-factor challenge");
        var hadKey = user.AuthHash is not null;
        if (!LoginKeyAuth.ApplyPendingMove(user, packed))
            throw DomainException.Unauthorized("invalid or expired two-factor challenge");
        if (hadKey) return; // another device moved it meanwhile: its credential stays
        await userManager.UpdateAsync(user);
        await audit.AddAsync(user.Id, "login_key_set", "user", user.Id, "moved to sign-in without the password", ct);
    }
}
