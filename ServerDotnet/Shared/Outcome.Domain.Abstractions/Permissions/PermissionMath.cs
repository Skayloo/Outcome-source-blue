namespace Outcome.Domain.Permissions;

/// <summary>
/// Permission resolution helpers. Mirrors Server/permissions/permissions.go.
/// Channel override semantics (Discord-style): effective = (rolePerm &amp; ~deny) | allow,
/// so <c>allow</c> wins over <c>deny</c> when both target the same bit.
/// </summary>
public static class PermissionMath
{
    /// <summary>Applies a channel override: deny strips bits first, allow adds them after.</summary>
    public static long Effective(long rolePerms, long allow, long deny) => (rolePerms & ~deny) | allow;

    /// <summary>True if the permission set carries the Administrator bit (unconditional access).</summary>
    public static bool HasAdmin(long perms) => (perms & Permission.Administrator) != 0;

    /// <summary>True if <paramref name="perms"/> contains ALL bits in <paramref name="required"/> (zero is never valid).</summary>
    public static bool HasAll(long perms, long required)
    {
        if (required == 0) return false;
        return (perms & required) == required;
    }

    /// <summary>True if <paramref name="perms"/> contains ANY bit in <paramref name="required"/> (matches middleware RequirePermission).</summary>
    public static bool HasAny(long perms, long required) => (perms & required) != 0;
}
