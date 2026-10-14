namespace Outcome.Domain.Permissions;

/// <summary>
/// Canonical permission bit constants (int64 flags). Bit positions are the contract
/// shared with the database and the frontend — must match the Go backend exactly
/// (Server/permissions/permissions.go). Do not renumber.
/// </summary>
public static class Permission
{
    public const long None = 0L;

    public const long SendMessages   = 1L << 0;   // 0x0001
    public const long ReadMessages   = 1L << 1;   // 0x0002
    public const long AttachFiles    = 1L << 5;   // 0x0020
    public const long AddReactions   = 1L << 6;   // 0x0040
    public const long UseSoundboard  = 1L << 8;   // 0x0100
    public const long ConnectVoice   = 1L << 9;   // 0x0200
    public const long SpeakVoice     = 1L << 10;  // 0x0400
    public const long UseVideo       = 1L << 11;  // 0x0800
    public const long ShareScreen    = 1L << 12;  // 0x1000
    /// <summary>Record a call in this server's voice rooms (W3GWG-25 stage 4). The recording is made
    /// on the recorder's own computer; what the server governs is the announcement every
    /// participant sees, which it makes only for holders of this bit.</summary>
    public const long RecordCalls    = 1L << 13;  // 0x2000
    public const long ManageMessages = 1L << 16;  // 0x10000
    public const long ManageChannels = 1L << 17;  // 0x20000
    public const long KickMembers    = 1L << 18;  // 0x40000
    public const long BanMembers     = 1L << 19;  // 0x80000
    public const long MuteMembers    = 1L << 20;  // 0x100000
    public const long ManageRoles    = 1L << 24;  // 0x1000000
    public const long ManageServer   = 1L << 25;  // 0x2000000
    public const long ManageInvites  = 1L << 26;  // 0x4000000
    public const long ViewAuditLog   = 1L << 27;  // 0x8000000
    public const long Administrator  = 1L << 30;  // 0x40000000 — bypasses all checks

    /// <summary>
    /// What the owner of the ACTIVE server is granted inside it, and the only place that set is
    /// written down. Three bits, and the shortness is the point: every one of them is meaningless
    /// outside a channel of the current server, so none of them can open an instance-wide door.
    ///
    /// It used to also carry ManageServer, ManageRoles, KickMembers, MuteMembers and ViewAuditLog
    /// — "server-scoped" by intention and by nothing else. Those bits are exactly what the
    /// space-wide handlers gate on, so anyone who created a server (which needs no permission at
    /// all) could list every account in the space, read the whole audit log, kill anyone's
    /// sessions, and reassign the global role of any user — including demoting the instance owner.
    /// Renaming the server, removing its members and setting per-server roles never needed these:
    /// those endpoints check ownership directly, which is why dropping them cost nothing.
    ///
    /// Nothing may be added here without checking what ELSE gates on that bit. A bit that any
    /// instance-wide handler accepts does not belong in this set.
    /// </summary>
    public const long ServerOwnerGrant = ManageChannels | ManageInvites | ManageMessages | RecordCalls;
}

/// <summary>A person's role INSIDE one server. It is a different thing from the space role on
/// <c>users.role_id</c> (Owner / Admin / Member of the whole space): the two shared one list of
/// names, so a server's creator showed up as "Member" and a per-server "Admin" granted nothing.
/// The owner is <c>servers.owner_id</c>; Admin and Moderator are stored in
/// <c>server_members.role_id</c> as the seeded role ids 2 and 3 (null or anything else = Member).</summary>
public enum ServerRole { None = 0, Member = 1, Moderator = 2, Admin = 3, Owner = 4 }

public static class ServerRoles
{
    public static ServerRole FromMember(bool isOwner, bool isMember, long? storedRoleId) =>
        isOwner ? ServerRole.Owner
        : !isMember ? ServerRole.None
        : storedRoleId == DefaultRole.Admin ? ServerRole.Admin
        : storedRoleId == DefaultRole.Moderator ? ServerRole.Moderator
        : ServerRole.Member;

    /// <summary>What <c>server_members.role_id</c> holds for a role a manager picks.</summary>
    public static long? StoredRoleId(ServerRole role) => role switch
    {
        ServerRole.Admin => DefaultRole.Admin,
        ServerRole.Moderator => DefaultRole.Moderator,
        _ => null,
    };

    /// <summary>The permission bits a server role adds inside THAT server. Only server-scoped bits:
    /// see <see cref="Permission.ServerOwnerGrant"/> for why nothing an instance-wide handler gates
    /// on may appear here. Kicking, renaming the server and assigning roles are not bits at all —
    /// the endpoints check the server role itself.</summary>
    public static long Grant(ServerRole role) => role switch
    {
        ServerRole.Owner or ServerRole.Admin => Permission.ServerOwnerGrant,
        ServerRole.Moderator => Permission.ManageMessages | Permission.ManageInvites,
        _ => Permission.None,
    };

    /// <summary>Manages the server: name, picture, visibility, members' roles, removing members.</summary>
    public static bool CanManage(ServerRole role) => role is ServerRole.Owner or ServerRole.Admin;

    public static string Name(ServerRole role) => role switch
    {
        ServerRole.Owner => "owner",
        ServerRole.Admin => "admin",
        ServerRole.Moderator => "moderator",
        _ => "member",
    };

    public static bool TryParse(string? name, out ServerRole role)
    {
        role = (name ?? "").Trim().ToLowerInvariant() switch
        {
            "admin" => ServerRole.Admin,
            "moderator" => ServerRole.Moderator,
            "member" => ServerRole.Member,
            _ => ServerRole.None,
        };
        return role != ServerRole.None;
    }
}

/// <summary>Default role IDs inserted on first run (must match Go).</summary>
public static class DefaultRole
{
    public const long Owner = 1;
    public const long Admin = 2;
    public const long Moderator = 3;
    public const long Member = 4;

    /// <summary>Hierarchy position of the owner role; roles below this cannot modify it.</summary>
    public const int OwnerPosition = 100;
}

/// <summary>Default role NAME constants (mirrors api_mobstra_analytics <c>Roles</c>).</summary>
public static class RoleNames
{
    public const string Owner = "Owner";
    public const string Admin = "Admin";
    public const string Moderator = "Moderator";
    public const string Member = "Member";
}
