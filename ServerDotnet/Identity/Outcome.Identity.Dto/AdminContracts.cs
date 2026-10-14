namespace Outcome.Application.Admin;

/// <summary>Admin user-list row. Returned by <c>IUserRepository.ListAdminUsersAsync</c>. Email is
/// here because the console is where an administrator finds out who an account belongs to; only
/// the space's Administrator reaches it (a per-server role never carries that bit).</summary>
public sealed record AdminUserDto(long Id, string Username, long RoleId, string Status, bool Banned, DateTime CreatedAt, string? Email,
    IReadOnlyList<string>? OwnedServers = null);

/// <summary>An invite as the space's administrator sees it: every server's, with the server it
/// lets people into and who made it — a bare code said neither, and the console showed only the
/// codes of whichever server the request happened to resolve to.</summary>
public sealed record AdminInviteDto(
    long Id, string Code, long ServerId, string ServerName, long CreatedBy, string CreatedByName,
    int? MaxUses, int UseCount, DateTime? ExpiresAt, DateTime CreatedAt);

/// <summary>An audit-log row joined with the actor's username, for the admin Audit Log view.</summary>
public sealed record AuditEntryDto(
    long Id, long ActorId, string ActorName, string Action, string TargetType, long TargetId, string Detail, DateTime CreatedAt);

/// <summary>Server diagnostics counters (DB-derived). Online/uptime/version are added by the endpoint.</summary>
public sealed record AdminStatsDto(int Users, int Messages, int Channels, int Servers, int Invites, long DbSizeBytes);
