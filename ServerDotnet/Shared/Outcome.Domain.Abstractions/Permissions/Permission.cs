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
