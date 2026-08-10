namespace Outcome.Shared.Abstractions.Persistence;

/// <summary>A server (tenant) the user can see in the rail.</summary>
public sealed record ServerInfo(long Id, string Name, long OwnerId, string? Icon, string? CustomDomain = null);

/// <summary>A public server as listed in the Explore directory.</summary>
public sealed record PublicServerInfo(long Id, string Name, string Description, string? Icon, int MemberCount);

/// <summary>A server's discovery settings.</summary>
public sealed record ServerVisibility(bool IsPublic, string Description);

/// <summary>Server (tenant) membership + creation. Channels/roles/invites scope to a server.</summary>
public interface IServerRepository
{
    Task<IReadOnlyList<ServerInfo>> ListForUserAsync(long userId, CancellationToken ct = default);
    /// <summary>Every non-deleted server (instance-admin view).</summary>
    Task<IReadOnlyList<ServerInfo>> ListAllAsync(int limit = int.MaxValue, int offset = 0, CancellationToken ct = default);
    /// <summary>Non-deleted servers total — the denominator for the admin list's pagination.</summary>
    Task<int> CountAllAsync(CancellationToken ct = default);
    /// <summary>Force-delete ANY server (instance admin, no owner check). False if not found.</summary>
    Task<bool> AdminDeleteAsync(long serverId, CancellationToken ct = default);
    /// <summary>The user's primary server id (lowest joined), or 0 if none.</summary>
    Task<long> GetFirstForUserAsync(long userId, CancellationToken ct = default);
    Task<bool> IsMemberAsync(long serverId, long userId, CancellationToken ct = default);
    Task<ServerInfo?> GetAsync(long serverId, CancellationToken ct = default);
    /// <summary>Number of non-deleted servers this user owns (for the create limit).</summary>
    Task<int> CountOwnedAsync(long ownerId, CancellationToken ct = default);
    /// <summary>Creates a server with default channels, makes <paramref name="ownerId"/> an owner member.</summary>
    Task<ServerInfo> CreateAsync(string name, long ownerId, CancellationToken ct = default);
    Task AddMemberAsync(long serverId, long userId, long? roleId, CancellationToken ct = default);
    /// <summary>Remove a member from a server (per-server kick). False if they weren't a member.</summary>
    Task<bool> RemoveMemberAsync(long serverId, long userId, CancellationToken ct = default);
    /// <summary>The user's per-server role id in this server, or null if not a member / unassigned.</summary>
    Task<long?> GetMemberRoleAsync(long serverId, long userId, CancellationToken ct = default);
    /// <summary>Assigns (or clears, with null) a member's per-server role. Returns false if not a member.</summary>
    Task<bool> AssignMemberRoleAsync(long serverId, long userId, long? roleId, CancellationToken ct = default);
    /// <summary>Rename a server. False if it doesn't exist.</summary>
    Task<bool> RenameAsync(long serverId, string name, CancellationToken ct = default);
    /// <summary>Owner sets (or clears, with null) this space's custom domain. False if not found
    /// or the requester isn't the owner. The domain must be pre-normalized + unique.</summary>
    Task<bool> SetCustomDomainAsync(long serverId, long ownerId, string? domain, CancellationToken ct = default);
    /// <summary>Instance admin sets (or clears) a space's domain — no owner check. We hand
    /// customers a subdomain of ours, and the space is often owned by them, not by us.</summary>
    Task<bool> AdminSetCustomDomainAsync(long serverId, string? domain, CancellationToken ct = default);

    /// <summary>Space logo (an /api/v1/files/{id} url, or null to clear it). Instance-admin path.</summary>
    Task<bool> SetIconAsync(long serverId, string? icon, CancellationToken ct = default);

    /// <summary>The space that owns a custom domain (host-only, lowercase), or null. For Host→space
    /// resolution + the Caddy on-demand-TLS ask endpoint.</summary>
    Task<ServerInfo?> FindByCustomDomainAsync(string domain, CancellationToken ct = default);

    /// <summary>Member count per space, for the admin listing (seat counts drive billing).</summary>
    Task<IReadOnlyDictionary<long, int>> MemberCountsAsync(IReadOnlyCollection<long> serverIds, CancellationToken ct = default);
    /// <summary>Soft-deletes a server (owner only): removes all members, then marks it deleted.
    /// Returns false if the server doesn't exist or the requester isn't the owner.</summary>
    Task<bool> SoftDeleteAsync(long serverId, long requesterId, CancellationToken ct = default);

    // ── Public "Explore" directory ───────────────────────────────────────────
    /// <summary>Public, non-deleted servers the user is NOT already a member of, with member counts.</summary>
    Task<IReadOnlyList<PublicServerInfo>> DiscoverAsync(long userId, CancellationToken ct = default);
    /// <summary>A server's public/description settings, or null if it doesn't exist.</summary>
    Task<ServerVisibility?> GetVisibilityAsync(long serverId, CancellationToken ct = default);
    /// <summary>Owner sets public flag + description. False if not found or requester isn't the owner.</summary>
    Task<bool> SetVisibilityAsync(long serverId, long ownerId, bool isPublic, string description, CancellationToken ct = default);
    /// <summary>Join a PUBLIC server without an invite. Returns the server if public + joined
    /// (idempotent if already a member), or null if the server isn't public / doesn't exist.</summary>
    Task<ServerInfo?> JoinPublicAsync(long serverId, long userId, CancellationToken ct = default);
}
