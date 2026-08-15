namespace Outcome.Api.Security;

/// <summary>
/// The keys under which the authorization middleware caches membership, roles, permissions and
/// ownership in the process-wide <c>IMemoryCache</c>.
///
/// They live here because three places have to agree on them: the two middlewares that WRITE the
/// entries and the endpoints that EVICT them when a role is reassigned or a member is kicked. When
/// the format was spelled out at each call site they drifted — the writers were fixed to include
/// the space and the evictions were not, so a kick stopped revoking access until the entry expired
/// on its own.
///
/// Every key carries the space. One cache serves every space, and each space is a separate
/// database numbering its users and servers from 1, so an unscoped key names a different subject
/// in each of them.
/// </summary>
public static class AuthCacheKeys
{
    /// <summary>Effective permission names for a user, instance-wide (no active server).</summary>
    public static string Perm(long spaceId, long userId) => $"s{spaceId}:perm:{userId}";

    /// <summary>Effective permission names for a user within one server.</summary>
    public static string Perm(long spaceId, long userId, long serverId) => $"s{spaceId}:perm:{userId}:{serverId}";

    /// <summary>Is this user a member of this server.</summary>
    public static string Member(long spaceId, long userId, long serverId) => $"s{spaceId}:mem:{userId}:{serverId}";

    /// <summary>The user's primary (first) server membership.</summary>
    public static string FirstServer(long spaceId, long userId) => $"s{spaceId}:first:{userId}";

    /// <summary>The user's per-server role assignment, 0 when they have none.</summary>
    public static string MemberRole(long spaceId, long userId, long serverId) => $"s{spaceId}:mrole:{userId}:{serverId}";

    /// <summary>The owner of a server.</summary>
    public static string Owner(long spaceId, long serverId) => $"s{spaceId}:owner:{serverId}";

    /// <summary>Whether a session token still maps to a live session.</summary>
    public static string Session(long spaceId, string tokenHash) => $"s{spaceId}:sess:{tokenHash}";
}
