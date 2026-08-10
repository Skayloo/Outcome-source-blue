using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

public sealed class BanUserHandler(IUserRepository users, IAuditRepository audit) : IRequestHandler<BanUserCommand>
{
    public async Task Handle(BanUserCommand cmd, CancellationToken ct)
    {
        AdminAuth.Require(cmd.Permissions, Outcome.Shared.Abstractions.Authorization.Permissions.BanMembers);
        if (cmd.TargetId == cmd.ActorId) throw DomainException.Forbidden("cannot ban yourself");
        var target = await users.GetByIdAsync(cmd.TargetId, ct) ?? throw DomainException.NotFound("user not found");
        if (target.RoleId == DefaultRole.Owner) throw DomainException.Forbidden("cannot ban the owner");

        await users.BanAsync(cmd.TargetId, cmd.Reason ?? string.Empty, ct);
        await audit.AddAsync(cmd.ActorId, "user_ban", "user", cmd.TargetId, cmd.Reason ?? string.Empty, ct);
    }
}
