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
        var target = await users.GetByIdAsync(cmd.UserId, ct) ?? throw DomainException.NotFound("user not found");
        // The instance owner is not a role you may take away. GuardEscalation does not stop this
        // on its own: it only compares what the NEW role carries, and every weaker role passes —
        // so demoting the owner to Member read as a legal downgrade. Ban and kick have had this
        // guard from the start; assignment is the one that could actually leave the instance with
        // nobody holding Administrator.
        if (target.RoleId == DefaultRole.Owner)
            throw DomainException.Forbidden("the owner's role can't be changed");
        // A space has ONE owner: the account that set it up (the setup wizard, or the owner seeded
        // when the space was created). The role is never handed out — not by an Admin (Owner and
        // Admin both carry Administrator, so GuardEscalation alone let one through), and not by the
        // Owner either: the owner's decision, 2026-10-13. The Owner makes Admins.
        if (cmd.RoleId == DefaultRole.Owner)
            throw DomainException.Forbidden("the space has one owner — the account that set it up; the role can't be given");
        await users.AssignRoleAsync(cmd.UserId, cmd.RoleId, ct);
    }
}
