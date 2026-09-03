using Outcome.Application.Admin;
using Outcome.Application.Friends;
using Outcome.Application.Realtime;
using Outcome.Application.Users;
using Outcome.Domain.Entities;

namespace Outcome.Shared.Abstractions.Persistence;

public interface IUserRepository
{
    Task<User?> GetByIdAsync(long id, CancellationToken ct = default);
    /// <summary>Several at once — a page of servers wants its owners without a query each.</summary>
    Task<IReadOnlyList<User>> ListByIdsAsync(IReadOnlyCollection<long> ids, CancellationToken ct = default);
    Task<User?> GetByUsernameAsync(string username, CancellationToken ct = default);
    Task<bool> ExistsByUsernameAsync(string username, CancellationToken ct = default);
    Task<User?> GetByEmailAsync(string email, CancellationToken ct = default);
    Task<bool> ExistsByEmailAsync(string email, CancellationToken ct = default);
    Task<long> CreateAsync(User user, CancellationToken ct = default);
    Task<int> CountAsync(CancellationToken ct = default);
    Task UpdateTotpSecretAsync(long id, string? secret, CancellationToken ct = default);
    /// <summary>Record the personal-data consent, ONCE. A second call is a no-op: what is
    /// stored is when this person first agreed and to which text, and later activity does not
    /// get to rewrite that.</summary>
    Task RecordConsentAsync(long id, string version, CancellationToken ct = default);
    Task UpdateStatusAsync(long id, string status, CancellationToken ct = default);
    /// <summary>Clear every leftover presence. Status is a cache of who holds a live socket,
    /// and a process that is killed (deploy, crash, OOM) never runs its disconnect handler —
    /// those rows would read "online" forever.</summary>
    Task<int> ResetPresenceAsync(CancellationToken ct = default);
    Task<IReadOnlyList<MemberDto>> ListMembersAsync(CancellationToken ct = default);
    /// <summary>Members of a specific server (tenant) only — for the server-scoped WS ready roster.</summary>
    Task<IReadOnlyList<MemberDto>> ListMembersForServerAsync(long serverId, CancellationToken ct = default);
    Task<IReadOnlyList<AdminUserDto>> ListAdminUsersAsync(int limit = int.MaxValue, int offset = 0, string? search = null, CancellationToken ct = default);
    /// <summary>Non-deleted users only — the denominator for the admin list's pagination.</summary>
    Task<int> CountAdminUsersAsync(string? search = null, CancellationToken ct = default);
    Task BanAsync(long id, string reason, CancellationToken ct = default);
    Task UnbanAsync(long id, CancellationToken ct = default);
    Task<int> CountAdminsExceptAsync(long exceptUserId, CancellationToken ct = default);
    Task DeleteAsync(long id, CancellationToken ct = default);
    /// <summary>Soft-deletes the account: soft-deletes the user's messages (kept for "Deleted message"
    /// reply placeholders), removes memberships/sessions, and marks the user deleted.</summary>
    Task SoftDeleteAsync(long id, CancellationToken ct = default);
    Task AssignRoleAsync(long userId, long roleId, CancellationToken ct = default);
    Task ReassignRoleAsync(long fromRoleId, long toRoleId, CancellationToken ct = default);
    Task UpdateProfileAsync(long id, string? username, string? avatar, bool? pushPreview = null, CancellationToken ct = default);

    /// <summary>Is this file somebody's avatar? Avatars are stored as a bare path and shown to
    /// anyone who can see the person — including guests with no session — so they are the one
    /// upload that must stay fetchable without a signed link.</summary>
    Task<bool> IsAvatarAsync(string filePath, CancellationToken ct = default);
    Task UpdatePasswordAsync(long id, string passwordHash, CancellationToken ct = default);
    Task<IReadOnlyList<UserSearchDto>> SearchAsync(string query, long excludeUserId, int limit, CancellationToken ct = default);
}

public interface IFriendRepository
{
    Task<FriendsListDto> ListAsync(long userId, CancellationToken ct = default);
    Task<(bool created, bool autoAccepted)> SendRequestAsync(long fromUserId, long toUserId, CancellationToken ct = default);
    Task<bool> AcceptAsync(long userId, long otherId, CancellationToken ct = default);
    Task<bool> RemoveAsync(long userId, long otherId, CancellationToken ct = default);
    Task<bool> AreFriendsAsync(long a, long b, CancellationToken ct = default);
}

public interface IRoleRepository
{
    Task<Role?> GetByIdAsync(long id, CancellationToken ct = default);
    Task<IReadOnlyList<Role>> ListAsync(CancellationToken ct = default);
    Task<long> CreateAsync(Role role, CancellationToken ct = default);
    Task UpdateAsync(Role role, CancellationToken ct = default);
    Task DeleteAsync(long id, CancellationToken ct = default);
}

public interface ISessionRepository
{
    Task CreateAsync(Session session, CancellationToken ct = default);
    Task<Session?> GetByTokenHashAsync(string tokenHash, CancellationToken ct = default);
    Task DeleteByTokenHashAsync(string tokenHash, CancellationToken ct = default);
    Task UpdateLastUsedAsync(string tokenHash, DateTime when, CancellationToken ct = default);
    Task<IReadOnlyList<Session>> ListForUserAsync(long userId, CancellationToken ct = default);
    Task<bool> DeleteByIdForUserAsync(long id, long userId, CancellationToken ct = default);
    Task DeleteAllForUserAsync(long userId, CancellationToken ct = default);
    /// <summary>"Sign out everywhere else": deletes the user's sessions except the one
    /// identified by the given token hash. Returns how many were revoked.</summary>
    Task<int> DeleteAllForUserExceptAsync(long userId, string exceptTokenHash, CancellationToken ct = default);
}

/// <summary>Push destinations (APNs device tokens) for this space's users.</summary>
public interface IDeviceTokenRepository
{
    /// <summary>Registers the token for this user, moving it off any other account that held it.</summary>
    Task RegisterAsync(long userId, string token, string platform, string kind, CancellationToken ct = default);
    /// <param name="userId">When given, only that user's row goes — nobody should be able to
    /// silence someone else's phone by guessing its token.</param>
    Task RemoveAsync(string token, long? userId = null, CancellationToken ct = default);
    /// <summary>Every device of these users registered for <paramref name="kind"/> of push.</summary>
    Task<IReadOnlyList<DeviceToken>> ListForUsersAsync(IReadOnlyCollection<long> userIds, string kind = "alert", CancellationToken ct = default);
    /// <summary>Remembers that this token belongs to Apple's sandbox gateway.</summary>
    Task MarkSandboxAsync(string token, CancellationToken ct = default);
}

/// <summary>Read-side admin metrics: diagnostics counters + paginated audit log (joined with actor names).</summary>
public interface IAdminMetricsRepository
{
    Task<AdminStatsDto> GetStatsAsync(CancellationToken ct = default);
    Task<IReadOnlyList<AuditEntryDto>> GetAuditAsync(int limit, int offset, CancellationToken ct = default);
    Task<int> CountAuditAsync(CancellationToken ct = default);
}

public interface IInviteRepository
{
    Task<Invite?> GetByCodeAsync(string code, CancellationToken ct = default);
    Task ConsumeAsync(long inviteId, long redeemedBy, CancellationToken ct = default);
    Task<long> CreateAsync(Invite invite, CancellationToken ct = default);
    Task<IReadOnlyList<Invite>> ListAsync(long serverId, int limit = int.MaxValue, int offset = 0, CancellationToken ct = default);
    /// <summary>Active (non-revoked) invites for the server — pairs with ListAsync's filter.</summary>
    Task<int> CountAsync(long serverId, CancellationToken ct = default);
    Task<bool> RevokeAsync(long serverId, string code, CancellationToken ct = default);
}
