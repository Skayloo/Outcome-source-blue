using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Outcome.Application.Auth;
using Outcome.Domain.Entities;
using Outcome.Infrastructure.Persistence;
using Outcome.Infrastructure.Tenancy;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Api.Security;

/// <summary>
/// Keeps the password hashes of accounts made before login v2 WRAPPED, never plain
/// (<see cref="LoginKeys.WrapPrefix"/>). The proof that moves such an account is its old hash, so a
/// plain one read out of the database — a leaked dump, a stolen backup — signed the account in by
/// itself, no password guessed. A moved account needs its old hash for nothing, so that one is
/// dropped. Runs at every start (rows written by a server put back, or restored from a backup, are
/// caught the next time); each row is changed only if nobody changed it meanwhile, so a sign-in
/// moving the account at that moment keeps its own result.
/// </summary>
internal static class LegacyHashes
{
    public static async Task WrapAsync(IServiceProvider services, ILogger logger)
    {
        var registry = services.GetRequiredService<SpaceRegistry>();
        var scopes = services.GetRequiredService<IServiceScopeFactory>();
        foreach (var space in await registry.ListAsync())
        {
            if (!space.Active) continue;
            try
            {
                await using var scope = scopes.CreateAsyncScopeFor(space);
                var db = scope.ServiceProvider.GetRequiredService<OutcomeDbContext>();
                var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher<User>>();

                var dropped = await db.Users
                    .Where(u => u.AuthHash != null && u.PasswordHash != null)
                    .ExecuteUpdateAsync(s => s.SetProperty(u => u.PasswordHash, (string?)null));

                var plain = await db.Users.AsNoTracking()
                    .Where(u => u.AuthHash == null && u.PasswordHash != null && !u.PasswordHash.StartsWith(LoginKeys.WrapPrefix))
                    .Select(u => new { u.Id, u.PasswordHash })
                    .ToListAsync();
                var wrapped = 0;
                foreach (var row in plain)
                {
                    // Not an old hash we can read (null): it moves nobody anyway, so it is left alone.
                    var wrap = LoginKeyAuth.WrapStored(new User { PasswordHash = row.PasswordHash }, hasher);
                    if (wrap is null) continue;
                    wrapped += await db.Users
                        .Where(u => u.Id == row.Id && u.AuthHash == null && u.PasswordHash == row.PasswordHash)
                        .ExecuteUpdateAsync(s => s.SetProperty(u => u.PasswordHash, wrap));
                }
                if (dropped + wrapped > 0)
                    logger.LogInformation("Space {Space}: wrapped {Wrapped} old password hashes, dropped {Dropped} left by moved accounts",
                        space.Id, wrapped, dropped);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Wrapping old password hashes failed for space {Space}", space.Id);
            }
        }
    }
}
