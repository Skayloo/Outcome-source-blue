using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

public sealed class KickUserHandler(IUserRepository users, ISessionRepository sessions, IAuditRepository audit)
    : IRequestHandler<KickUserCommand>
{
    public async Task Handle(KickUserCommand cmd, CancellationToken ct)
    {
        AdminAuth.Require(cmd.Permissions, Outcome.Shared.Abstractions.Authorization.Permissions.KickMembers);
        if (cmd.TargetId == cmd.ActorId) throw DomainException.Forbidden("cannot kick yourself");
        var target = await users.GetByIdAsync(cmd.TargetId, ct) ?? throw DomainException.NotFound("user not found");
        if (target.RoleId == DefaultRole.Owner) throw DomainException.Forbidden("cannot kick the owner");

        await sessions.DeleteAllForUserAsync(cmd.TargetId, ct);
        await audit.AddAsync(cmd.ActorId, "user_kick", "user", cmd.TargetId, string.Empty, ct);
    }
}
