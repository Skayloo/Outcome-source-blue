using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Authorization;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Roles;

public sealed class UpdateRoleHandler(IRoleRepository roles, IPermissionRepository permissions) : IRequestHandler<UpdateRoleCommand, RoleDto>
{
    public async Task<RoleDto> Handle(UpdateRoleCommand cmd, CancellationToken ct)
    {
        RoleAuth.RequireManageRoles(cmd.ActorPermissions);
        var role = await roles.GetByIdAsync(cmd.RoleId, ct) ?? throw DomainException.NotFound("role not found");

        if (cmd.Permissions is { } perms)
        {
            RoleAuth.GuardEscalation(cmd.ActorPermissions, perms);
            role.Permissions = perms;
        }
        if (cmd.Name is not null) role.Name = RoleAuth.ValidateName(cmd.Name);
        if (cmd.Color is not null) role.Color = cmd.Color;
        if (cmd.Position is { } position) role.Position = position;

        await roles.UpdateAsync(role, ct);
        if (cmd.Permissions is not null) await permissions.SetForRoleAsync(role.Id, Permissions.FromBits(role.Permissions), ct);
        return RoleMapper.ToDto(role);
    }
}
