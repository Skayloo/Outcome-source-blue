using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Roles;

public sealed class AssignRoleHandler(IRoleRepository roles, IUserRepository users) : IRequestHandler<AssignRoleCommand>
{
    public async Task Handle(AssignRoleCommand cmd, CancellationToken ct)
    {
        RoleAuth.RequireManageRoles(cmd.ActorPermissions);
        var role = await roles.GetByIdAsync(cmd.RoleId, ct) ?? throw DomainException.NotFound("role not found");
        RoleAuth.GuardEscalation(cmd.ActorPermissions, role.Permissions); // can't grant a role more powerful than yourself
        _ = await users.GetByIdAsync(cmd.UserId, ct) ?? throw DomainException.NotFound("user not found");
        await users.AssignRoleAsync(cmd.UserId, cmd.RoleId, ct);
    }
}
