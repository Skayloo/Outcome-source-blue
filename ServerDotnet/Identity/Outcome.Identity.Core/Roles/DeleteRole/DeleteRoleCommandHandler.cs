using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Roles;

public sealed class DeleteRoleHandler(IRoleRepository roles, IUserRepository users) : IRequestHandler<DeleteRoleCommand>
{
    public async Task Handle(DeleteRoleCommand cmd, CancellationToken ct)
    {
        RoleAuth.RequireManageRoles(cmd.ActorPermissions);
        var role = await roles.GetByIdAsync(cmd.RoleId, ct) ?? throw DomainException.NotFound("role not found");
        if (role.Id <= DefaultRole.Member) throw DomainException.Forbidden("cannot delete a default role");

        await users.ReassignRoleAsync(cmd.RoleId, DefaultRole.Member, ct); // move members to the default role
        await roles.DeleteAsync(cmd.RoleId, ct);
    }
}
