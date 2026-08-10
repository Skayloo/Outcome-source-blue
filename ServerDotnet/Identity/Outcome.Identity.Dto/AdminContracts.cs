namespace Outcome.Application.Admin;

/// <summary>Admin user-list row. Returned by <c>IUserRepository.ListAdminUsersAsync</c>.</summary>
public sealed record AdminUserDto(long Id, string Username, long RoleId, string Status, bool Banned, DateTime CreatedAt);

/// <summary>An audit-log row joined with the actor's username, for the admin Audit Log view.</summary>
public sealed record AuditEntryDto(
    long Id, long ActorId, string ActorName, string Action, string TargetType, long TargetId, string Detail, DateTime CreatedAt);

/// <summary>Server diagnostics counters (DB-derived). Online/uptime/version are added by the endpoint.</summary>
public sealed record AdminStatsDto(int Users, int Messages, int Channels, int Servers, int Invites, long DbSizeBytes);
