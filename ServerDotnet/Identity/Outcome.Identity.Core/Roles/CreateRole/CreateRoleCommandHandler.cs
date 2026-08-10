using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Authorization;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Roles;

public sealed class CreateRoleHandler(IRoleRepository roles, IPermissionRepository permissions) : IRequestHandler<CreateRoleCommand, RoleDto>
{
    public async Task<RoleDto> Handle(CreateRoleCommand cmd, CancellationToken ct)
    {
        RoleAuth.RequireManageRoles(cmd.ActorPermissions);
        RoleAuth.GuardEscalation(cmd.ActorPermissions, cmd.Permissions);
        var role = new Role
        {
            Name = RoleAuth.ValidateName(cmd.Name),
            Color = cmd.Color,
            Permissions = cmd.Permissions,
            Position = cmd.Position,
            IsDefault = false,
        };
        role.Id = await roles.CreateAsync(role, ct);
        await permissions.SetForRoleAsync(role.Id, Permissions.FromBits(role.Permissions), ct);
        return RoleMapper.ToDto(role);
    }
}
