using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

public sealed class UnbanUserHandler(IUserRepository users, IAuditRepository audit) : IRequestHandler<UnbanUserCommand>
{
    public async Task Handle(UnbanUserCommand cmd, CancellationToken ct)
    {
        AdminAuth.Require(cmd.Permissions, Outcome.Shared.Abstractions.Authorization.Permissions.BanMembers);
        _ = await users.GetByIdAsync(cmd.TargetId, ct) ?? throw DomainException.NotFound("user not found");
        await users.UnbanAsync(cmd.TargetId, ct);
        await audit.AddAsync(cmd.ActorId, "user_unban", "user", cmd.TargetId, string.Empty, ct);
    }
}
