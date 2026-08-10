using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Auth;

public sealed class DeleteAccountHandler(
    IUserRepository users,
    IServerRepository servers,
    UserManager<User> userManager,
    IRateLimiter limiter,
    IAuditRepository audit) : IRequestHandler<DeleteAccountCommand>
{
    public async Task Handle(DeleteAccountCommand cmd, CancellationToken ct)
    {
        var user = await users.GetByIdAsync(cmd.UserId, ct) ?? throw DomainException.Unauthorized("not authenticated");

        var lockKey = $"delete_lock:{user.Id}";
        if (limiter.IsLockedOut(lockKey))
            throw DomainException.RateLimited("too many failed attempts, try again later");

        if (string.IsNullOrEmpty(cmd.Password))
            throw DomainException.InvalidInput("password is required");

        if (!await userManager.CheckPasswordAsync(user, cmd.Password))
        {
            if (!limiter.Allow($"delete_fail:{user.Id}", 3, TimeSpan.FromMinutes(15)))
                limiter.Lockout(lockKey, TimeSpan.FromMinutes(15));
            throw DomainException.InvalidInput("incorrect password");
        }
        limiter.Reset($"delete_fail:{user.Id}");

        // Last admin/owner guard.
        if (user.RoleId is DefaultRole.Owner or DefaultRole.Admin)
        {
            var otherAdmins = await users.CountAdminsExceptAsync(user.Id, ct);
            if (otherAdmins == 0)
                throw DomainException.Forbidden("cannot delete the last admin account");
        }

        // Soft-delete every server this user owns first (kicks the members of each), then the account.
        var mine = await servers.ListForUserAsync(user.Id, ct);
        foreach (var s in mine)
            if (s.OwnerId == user.Id)
                await servers.SoftDeleteAsync(s.Id, user.Id, ct);

        await audit.AddAsync(user.Id, "account_deleted", "user", user.Id, "account self-deleted (soft)", ct);
        await users.SoftDeleteAsync(user.Id, ct);
    }
}
