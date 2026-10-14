using Outcome.Shared.Abstractions.Security;
using P = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Api.Security;

/// <summary>Request-scoped holder for the authenticated principal, populated by auth middleware.</summary>
public sealed class CurrentUserContext : ICurrentUser
{
    public bool IsAuthenticated { get; private set; }
    public long UserId { get; private set; }
    public long RoleId { get; private set; }
    public long Permissions { get; private set; }
    public IReadOnlyCollection<string> PermissionNames { get; private set; } = [];
    public string? SessionTokenHash { get; private set; }

    public void Set(long userId, long roleId, long permissions, IReadOnlyCollection<string> permissionNames, string sessionTokenHash)
    {
        IsAuthenticated = true;
        UserId = userId;
        RoleId = roleId;
        Permissions = permissions;
        PermissionNames = permissionNames;
        SessionTokenHash = sessionTokenHash;
    }

    /// <summary>Adds what the caller's role INSIDE the active server grants
    /// (<see cref="Outcome.Domain.Permissions.ServerRoles.Grant"/>) for the rest of this request.
    /// Server-scoped bits only — no Administrator bypass, nothing an instance-wide handler accepts.
    /// Idempotent.</summary>
    public void GrantServerScope(long bits)
    {
        if (bits == 0 || (Permissions & bits) == bits) return;
        Permissions |= bits;
        // The bitfield and the name list are read by different call sites (PermCheck reads names),
        // so they have to move together or a permission holds in one check and not the other —
        // the hand-written name list this replaced had left RecordCalls out.
        var names = new List<string>(PermissionNames);
        foreach (var n in P.FromBits(bits))
            if (!names.Contains(n)) names.Add(n);
        PermissionNames = names;
    }
}
