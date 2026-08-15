using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Admin;
using Outcome.Application.Friends;
using Outcome.Application.Realtime;
using Outcome.Application.Users;
using Outcome.Domain.Entities;
using Outcome.Domain.Permissions;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class UserRepository(OutcomeDbContext db) : IUserRepository
{
    public Task<User?> GetByIdAsync(long id, CancellationToken ct = default) =>
        db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id, ct);

    public Task<User?> GetByUsernameAsync(string username, CancellationToken ct = default) =>
        db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.UserName!.ToLower() == username.ToLower(), ct);

    public Task<bool> ExistsByUsernameAsync(string username, CancellationToken ct = default) =>
        db.Users.AnyAsync(u => u.UserName!.ToLower() == username.ToLower(), ct);

    public Task<User?> GetByEmailAsync(string email, CancellationToken ct = default) =>
        db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email!.ToLower() == email.ToLower(), ct);

    public Task<bool> ExistsByEmailAsync(string email, CancellationToken ct = default) =>
        db.Users.AnyAsync(u => u.Email!.ToLower() == email.ToLower(), ct);

    public async Task<long> CreateAsync(User user, CancellationToken ct = default)
    {
        db.Users.Add(user);
        await db.SaveChangesAsync(ct);
        return user.Id;
    }

    public Task<int> CountAsync(CancellationToken ct = default) => db.Users.CountAsync(ct);

    public Task UpdateTotpSecretAsync(long id, string? secret, CancellationToken ct = default) =>
        db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(s => s.SetProperty(u => u.TotpSecret, secret), ct);

    public Task UpdateStatusAsync(long id, string status, CancellationToken ct = default) =>
        db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(s => s.SetProperty(u => u.Status, status), ct);

    public Task<int> ResetPresenceAsync(CancellationToken ct = default) =>
        db.Users.Where(u => u.Status != "offline")
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.Status, "offline"), ct);

    public async Task<IReadOnlyList<MemberDto>> ListMembersAsync(CancellationToken ct = default) =>
        await db.Users.AsNoTracking().Where(u => !u.Deleted).OrderBy(u => u.UserName)
            .Select(u => new MemberDto(u.Id, u.UserName!, u.Avatar, u.Status, u.RoleId, u.CreatedAt))
            .ToListAsync(ct);

    public async Task<IReadOnlyList<MemberDto>> ListMembersForServerAsync(long serverId, CancellationToken ct = default) =>
        await db.ServerMembers.AsNoTracking().Where(sm => sm.ServerId == serverId)
            .Join(db.Users.AsNoTracking().Where(u => !u.Deleted), sm => sm.UserId, u => u.Id, (sm, u) => u)
            .OrderBy(u => u.UserName)
            .Select(u => new MemberDto(u.Id, u.UserName!, u.Avatar, u.Status, u.RoleId, u.CreatedAt))
            .ToListAsync(ct);

    public async Task<IReadOnlyList<AdminUserDto>> ListAdminUsersAsync(int limit = int.MaxValue, int offset = 0, string? search = null, CancellationToken ct = default) =>
        await AdminUsersQuery(search).OrderBy(u => u.Id)
            .Skip(offset).Take(limit)
            .Select(u => new AdminUserDto(u.Id, u.UserName!, u.RoleId, u.Status, u.Banned, u.CreatedAt))
            .ToListAsync(ct);

    public Task<int> CountAdminUsersAsync(string? search = null, CancellationToken ct = default) =>
        AdminUsersQuery(search).CountAsync(ct);

    // Search must live server-side: the admin list is paginated, so a client-side filter
    // would only ever search the visible page.
    private IQueryable<User> AdminUsersQuery(string? search)
    {
        var q = db.Users.AsNoTracking().Where(u => !u.Deleted);
        if (!string.IsNullOrWhiteSpace(search))
            q = q.Where(u => EF.Functions.ILike(u.UserName!, $"%{search.Trim()}%"));
        return q;
    }

    public Task BanAsync(long id, string reason, CancellationToken ct = default) =>
        db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(u => u.Banned, true)
            .SetProperty(u => u.BanReason, reason)
            // Clear any stale temp-ban expiry — otherwise a past BanExpires makes this
            // "permanent" ban evaluate as already expired and never take effect.
            .SetProperty(u => u.BanExpires, (DateTime?)null), ct);

    public Task UnbanAsync(long id, CancellationToken ct = default) =>
        db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(u => u.Banned, false)
            .SetProperty(u => u.BanReason, (string?)null)
            .SetProperty(u => u.BanExpires, (DateTime?)null), ct);

    public Task<int> CountAdminsExceptAsync(long exceptUserId, CancellationToken ct = default) =>
        db.Users.CountAsync(u =>
            (u.RoleId == DefaultRole.Owner || u.RoleId == DefaultRole.Admin) && u.Id != exceptUserId && !u.Banned && !u.Deleted, ct);

    public async Task DeleteAsync(long id, CancellationToken ct = default)
    {
        // Hard delete. Only the FKs on `users` with NO ACTION need manual cleanup; everything
        // else (server_members, friendships, sessions, user_claims/roles/logins/tokens, reactions,
        // read_states, voice_states, dm_*) cascades on the user row.
        //
        // Servers the user OWNS (servers.owner_id is NO ACTION) must be purged first — deleting the
        // server row cascades to its channels → messages/reactions/read_states/voice/dm, and to its
        // roles/invites/members. This also covers messages by OTHER users inside those channels.
        await db.Servers.Where(s => s.OwnerId == id).ExecuteDeleteAsync(ct);

        // Remaining NO ACTION references to the user in servers they don't own.
        await db.Invites.Where(i => i.RedeemedBy == id).ExecuteUpdateAsync(s => s.SetProperty(i => i.RedeemedBy, (long?)null), ct);
        await db.Messages.Where(m => m.UserId == id).ExecuteDeleteAsync(ct);
        await db.Invites.Where(i => i.CreatedBy == id).ExecuteDeleteAsync(ct);
        await db.Emojis.Where(e => e.UploadedBy == id).ExecuteDeleteAsync(ct);
        await db.Sounds.Where(s => s.UploadedBy == id).ExecuteDeleteAsync(ct);
        await db.Users.Where(u => u.Id == id).ExecuteDeleteAsync(ct);
    }

    // Self-service account deletion (recoverable). The user's content is soft-deleted, not purged:
    // their messages stay in the DB with deleted=true so that replies to them can still render a
    // "Deleted message" placeholder, and the account itself is hidden from auth + member lists.
    public async Task SoftDeleteAsync(long id, CancellationToken ct = default)
    {
        await db.Messages.Where(m => m.UserId == id && !m.Deleted)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.Deleted, true), ct);
        // Kick from every server they belong to; revoke invites they issued.
        await db.ServerMembers.Where(sm => sm.UserId == id).ExecuteDeleteAsync(ct);
        await db.Invites.Where(i => i.CreatedBy == id && !i.Revoked)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.Revoked, true), ct);
        // Drop live sessions/voice so the account can't keep acting.
        await db.Sessions.Where(s => s.UserId == id).ExecuteDeleteAsync(ct);
        await db.VoiceStates.Where(v => v.UserId == id).ExecuteDeleteAsync(ct);
        // Push tokens go too. The privacy policy has always said they do, and they did not:
        // a deleted account left its Apple device tokens behind, which is both a promise the
        // software was not keeping and a way for a notification to reach a phone whose owner
        // had asked to be gone.
        await db.DeviceTokens.Where(d => d.UserId == id).ExecuteDeleteAsync(ct);
        // Release the name and the address. The row stays so old replies can still render a
        // "Deleted message" placeholder, but it stops squatting the two things a person needs to
        // come back: registration reads them straight out of this table and does not care that the
        // account is deleted, so "delete my account" quietly meant "and never use this email
        // again". The username is RENAMED rather than exempted from the check, because
        // normalized_user_name is a unique index — exempting it would trade a refusal at signup
        // for a constraint violation at insert.
        //
        // It is also the address itself: keeping a real mailbox on file for someone who asked to
        // be gone is the same promise the device tokens were breaking.
        await db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(u => u.Deleted, true)
            .SetProperty(u => u.DeletedAt, DateTime.UtcNow)
            .SetProperty(u => u.Status, "offline")
            .SetProperty(u => u.UserName, u => "deleted_" + u.Id)
            .SetProperty(u => u.NormalizedUserName, u => "DELETED_" + u.Id)
            .SetProperty(u => u.Email, u => "deleted_" + u.Id + "@deleted.invalid")
            .SetProperty(u => u.NormalizedEmail, u => "DELETED_" + u.Id + "@DELETED.INVALID"), ct);
    }

    public Task AssignRoleAsync(long userId, long roleId, CancellationToken ct = default) =>
        db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.RoleId, roleId), ct);

    public Task ReassignRoleAsync(long fromRoleId, long toRoleId, CancellationToken ct = default) =>
        db.Users.Where(u => u.RoleId == fromRoleId).ExecuteUpdateAsync(s => s.SetProperty(u => u.RoleId, toRoleId), ct);

    // normalized_user_name is what Identity's uniqueness check reads: writing username without
    // it leaves the OLD name squatting the unique index, and the new one invisible to
    // UserManager.FindByNameAsync.
    public Task<bool> IsAvatarAsync(string filePath, CancellationToken ct = default) =>
        db.Users.AsNoTracking().AnyAsync(u => u.Avatar == filePath, ct);

    public Task UpdateProfileAsync(long id, string? username, string? avatar, string? publicKey, string? e2eeBackup, bool? pushPreview = null, CancellationToken ct = default) =>
        db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(u => u.UserName, u => username ?? u.UserName)
            .SetProperty(u => u.NormalizedUserName, u => username != null ? username.ToUpper() : u.NormalizedUserName)
            .SetProperty(u => u.Avatar, u => avatar ?? u.Avatar)
            .SetProperty(u => u.PublicKey, u => publicKey ?? u.PublicKey)
            .SetProperty(u => u.E2eeBackup, u => e2eeBackup ?? u.E2eeBackup)
            .SetProperty(u => u.PushPreview, u => pushPreview ?? u.PushPreview), ct);

    public Task UpdatePasswordAsync(long id, string passwordHash, CancellationToken ct = default) =>
        db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(s => s.SetProperty(u => u.PasswordHash, passwordHash), ct);

    public async Task<IReadOnlyList<UserSearchDto>> SearchAsync(string query, long excludeUserId, int limit, CancellationToken ct = default)
    {
        var pattern = "%" + query + "%";
        return await db.Users.AsNoTracking()
            .Where(u => !u.Deleted && u.Id != excludeUserId
                && (EF.Functions.ILike(u.UserName!, pattern) || EF.Functions.ILike(u.Email!, pattern)))
            .OrderBy(u => u.UserName)
            .Take(limit)
            .Select(u => new UserSearchDto(u.Id, u.UserName!, u.Avatar, u.Status))
            .ToListAsync(ct);
    }
}

public sealed class FriendRepository(OutcomeDbContext db) : IFriendRepository
{
    private static (long low, long high) Canonical(long a, long b) => a < b ? (a, b) : (b, a);

    public async Task<FriendsListDto> ListAsync(long userId, CancellationToken ct = default)
    {
        // Every friendship row that involves this user, joined to the OTHER user's public fields.
        var rows = await (
            from f in db.Friendships.AsNoTracking()
            where f.UserLow == userId || f.UserHigh == userId
            let otherId = f.UserLow == userId ? f.UserHigh : f.UserLow
            join u in db.Users.AsNoTracking() on otherId equals u.Id
            where !u.Deleted
            select new { f.Status, f.RequestedBy, Other = new FriendDto(u.Id, u.UserName!, u.Avatar, u.Status) })
            .ToListAsync(ct);

        var friends = rows.Where(r => r.Status == "accepted").Select(r => r.Other).ToList();
        var incoming = rows.Where(r => r.Status == "pending" && r.RequestedBy != userId).Select(r => r.Other).ToList();
        var outgoing = rows.Where(r => r.Status == "pending" && r.RequestedBy == userId).Select(r => r.Other).ToList();
        return new FriendsListDto(friends, incoming, outgoing);
    }

    public async Task<(bool created, bool autoAccepted)> SendRequestAsync(long fromUserId, long toUserId, CancellationToken ct = default)
    {
        var (low, high) = Canonical(fromUserId, toUserId);
        var existing = await db.Friendships.FirstOrDefaultAsync(f => f.UserLow == low && f.UserHigh == high, ct);
        if (existing is not null)
        {
            // A pending request from the OTHER side means this send accepts it.
            if (existing.Status == "pending" && existing.RequestedBy == toUserId)
            {
                existing.Status = "accepted";
                await db.SaveChangesAsync(ct);
                return (false, true);
            }
            // Already friends, or I already have a pending request out — nothing to do.
            return (false, false);
        }

        db.Friendships.Add(new Friendship { UserLow = low, UserHigh = high, RequestedBy = fromUserId, Status = "pending" });
        await db.SaveChangesAsync(ct);
        return (true, false);
    }

    public async Task<bool> AcceptAsync(long userId, long otherId, CancellationToken ct = default)
    {
        var (low, high) = Canonical(userId, otherId);
        // Only the recipient (requested_by != userId) can accept a pending request.
        return await db.Friendships
            .Where(f => f.UserLow == low && f.UserHigh == high && f.Status == "pending" && f.RequestedBy != userId)
            .ExecuteUpdateAsync(s => s.SetProperty(f => f.Status, "accepted"), ct) > 0;
    }

    public async Task<bool> RemoveAsync(long userId, long otherId, CancellationToken ct = default)
    {
        var (low, high) = Canonical(userId, otherId);
        return await db.Friendships
            .Where(f => f.UserLow == low && f.UserHigh == high)
            .ExecuteDeleteAsync(ct) > 0;
    }

    public Task<bool> AreFriendsAsync(long a, long b, CancellationToken ct = default)
    {
        var (low, high) = Canonical(a, b);
        return db.Friendships.AnyAsync(f => f.UserLow == low && f.UserHigh == high && f.Status == "accepted", ct);
    }
}

public sealed class RoleRepository(OutcomeDbContext db) : IRoleRepository
{
    public Task<Role?> GetByIdAsync(long id, CancellationToken ct = default) =>
        db.Roles.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);

    public async Task<IReadOnlyList<Role>> ListAsync(CancellationToken ct = default) =>
        await db.Roles.AsNoTracking().OrderByDescending(r => r.Position).ThenBy(r => r.Id).ToListAsync(ct);

    public async Task<long> CreateAsync(Role role, CancellationToken ct = default)
    {
        db.Roles.Add(role);
        await db.SaveChangesAsync(ct);
        return role.Id;
    }

    public Task UpdateAsync(Role role, CancellationToken ct = default) =>
        db.Roles.Where(r => r.Id == role.Id).ExecuteUpdateAsync(s => s
            .SetProperty(r => r.Name, role.Name)
            .SetProperty(r => r.Color, role.Color)
            .SetProperty(r => r.Permissions, role.Permissions)
            .SetProperty(r => r.Position, role.Position), ct);

    public Task DeleteAsync(long id, CancellationToken ct = default) =>
        db.Roles.Where(r => r.Id == id).ExecuteDeleteAsync(ct);
}

public sealed class SessionRepository(OutcomeDbContext db) : ISessionRepository
{
    public async Task CreateAsync(Session session, CancellationToken ct = default)
    {
        db.Sessions.Add(session);
        await db.SaveChangesAsync(ct);
    }

    public Task<Session?> GetByTokenHashAsync(string tokenHash, CancellationToken ct = default) =>
        db.Sessions.AsNoTracking().FirstOrDefaultAsync(s => s.Token == tokenHash, ct);

    public Task DeleteByTokenHashAsync(string tokenHash, CancellationToken ct = default) =>
        db.Sessions.Where(s => s.Token == tokenHash).ExecuteDeleteAsync(ct);

    public Task UpdateLastUsedAsync(string tokenHash, DateTime when, CancellationToken ct = default) =>
        db.Sessions.Where(s => s.Token == tokenHash).ExecuteUpdateAsync(s => s.SetProperty(x => x.LastUsed, when), ct);

    public async Task<IReadOnlyList<Session>> ListForUserAsync(long userId, CancellationToken ct = default) =>
        await db.Sessions.AsNoTracking().Where(s => s.UserId == userId).OrderByDescending(s => s.LastUsed).ToListAsync(ct);

    public async Task<bool> DeleteByIdForUserAsync(long id, long userId, CancellationToken ct = default) =>
        await db.Sessions.Where(s => s.Id == id && s.UserId == userId).ExecuteDeleteAsync(ct) > 0;

    public Task DeleteAllForUserAsync(long userId, CancellationToken ct = default) =>
        db.Sessions.Where(s => s.UserId == userId).ExecuteDeleteAsync(ct);

    public Task<int> DeleteAllForUserExceptAsync(long userId, string exceptTokenHash, CancellationToken ct = default) =>
        db.Sessions.Where(s => s.UserId == userId && s.Token != exceptTokenHash).ExecuteDeleteAsync(ct);
}

public sealed class SettingsRepository(OutcomeDbContext db) : ISettingsRepository
{
    public Task<string?> GetAsync(string key, CancellationToken ct = default) =>
        db.Settings.AsNoTracking().Where(s => s.Key == key).Select(s => s.Value).FirstOrDefaultAsync(ct);

    public async Task<IReadOnlyDictionary<string, string>> GetAllAsync(CancellationToken ct = default) =>
        await db.Settings.AsNoTracking().ToDictionaryAsync(s => s.Key, s => s.Value, ct);

    public async Task SetAsync(string key, string value, CancellationToken ct = default)
    {
        var existing = await db.Settings.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (existing is null) db.Settings.Add(new Setting { Key = key, Value = value });
        else existing.Value = value;
        await db.SaveChangesAsync(ct);
    }
}

public sealed class InviteRepository(OutcomeDbContext db) : IInviteRepository
{
    public Task<Invite?> GetByCodeAsync(string code, CancellationToken ct = default) =>
        db.Invites.AsNoTracking().FirstOrDefaultAsync(i => i.Code == code, ct);

    public Task ConsumeAsync(long inviteId, long redeemedBy, CancellationToken ct = default) =>
        db.Invites.Where(i => i.Id == inviteId).ExecuteUpdateAsync(s => s
            .SetProperty(i => i.UseCount, i => i.UseCount + 1)
            .SetProperty(i => i.RedeemedBy, redeemedBy), ct);

    public async Task<long> CreateAsync(Invite invite, CancellationToken ct = default)
    {
        db.Invites.Add(invite);
        await db.SaveChangesAsync(ct);
        return invite.Id;
    }

    public async Task<IReadOnlyList<Invite>> ListAsync(long serverId, int limit = int.MaxValue, int offset = 0, CancellationToken ct = default) =>
        // Exclude revoked invites — otherwise a revoked invite reappears on the next page load
        // (revoke persists Revoked=true, but the list wasn't filtering on it).
        await db.Invites.AsNoTracking().Where(i => i.ServerId == serverId && !i.Revoked)
            .OrderByDescending(i => i.Id).Skip(offset).Take(limit).ToListAsync(ct);

    public Task<int> CountAsync(long serverId, CancellationToken ct = default) =>
        db.Invites.AsNoTracking().CountAsync(i => i.ServerId == serverId && !i.Revoked, ct);

    public async Task<bool> RevokeAsync(long serverId, string code, CancellationToken ct = default) =>
        await db.Invites.Where(i => i.Code == code && i.ServerId == serverId)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.Revoked, true), ct) > 0;
}

public sealed class AuditRepository(OutcomeDbContext db) : IAuditRepository
{
    public async Task AddAsync(long actorId, string action, string targetType, long targetId, string detail, CancellationToken ct = default)
    {
        db.AuditLog.Add(new AuditLogEntry
        {
            ActorId = actorId,
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Detail = detail,
        });
        await db.SaveChangesAsync(ct);
    }
}

public sealed class AdminMetricsRepository(OutcomeDbContext db) : IAdminMetricsRepository
{
    public async Task<AdminStatsDto> GetStatsAsync(CancellationToken ct = default)
    {
        var users    = await db.Users.CountAsync(u => !u.Deleted, ct);
        var messages = await db.Messages.CountAsync(m => !m.Deleted, ct);
        var channels = await db.Channels.CountAsync(c => !c.Deleted, ct);
        var servers  = await db.Servers.CountAsync(s => !s.Deleted, ct);
        var invites  = await db.Invites.CountAsync(i => !i.Revoked, ct);
        long dbSize  = 0;
        try
        {
            dbSize = await db.Database
                .SqlQueryRaw<long>("SELECT pg_database_size(current_database()) AS \"Value\"")
                .FirstAsync(ct);
        }
        catch { /* size is best-effort */ }
        return new AdminStatsDto(users, messages, channels, servers, invites, dbSize);
    }

    public Task<int> CountAuditAsync(CancellationToken ct = default) =>
        db.AuditLog.AsNoTracking().CountAsync(ct);

    public async Task<IReadOnlyList<AuditEntryDto>> GetAuditAsync(int limit, int offset, CancellationToken ct = default)
    {
        var rows = await db.AuditLog.AsNoTracking()
            .OrderByDescending(a => a.Id)
            .Skip(offset).Take(limit)
            .Select(a => new { a.Id, a.ActorId, a.Action, a.TargetType, a.TargetId, a.Detail, a.CreatedAt })
            .ToListAsync(ct);
        if (rows.Count == 0) return [];

        var ids = rows.Select(r => r.ActorId).Distinct().ToList();
        var names = await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .Select(u => new { u.Id, u.UserName })
            .ToDictionaryAsync(x => x.Id, x => x.UserName!, ct);

        return rows.Select(r => new AuditEntryDto(
            r.Id, r.ActorId,
            names.GetValueOrDefault(r.ActorId, r.ActorId == 0 ? "system" : "deleted user"),
            r.Action, r.TargetType, r.TargetId, r.Detail, r.CreatedAt)).ToList();
    }
}

public sealed class AttachmentRepository(OutcomeDbContext db) : IAttachmentRepository
{
    public async Task CreateAsync(Attachment attachment, CancellationToken ct = default)
    {
        db.Attachments.Add(attachment);
        await db.SaveChangesAsync(ct);
    }

    public Task<Attachment?> GetByIdAsync(string id, CancellationToken ct = default) =>
        db.Attachments.AsNoTracking().FirstOrDefaultAsync(a => a.Id == id, ct);

    public async Task<IReadOnlyList<Attachment>> AttachToMessageAsync(IReadOnlyList<string> ids, long messageId, CancellationToken ct = default)
    {
        if (ids.Count == 0) return Array.Empty<Attachment>();
        var atts = await db.Attachments.Where(a => ids.Contains(a.Id)).ToListAsync(ct);
        var result = new List<Attachment>();
        foreach (var id in ids)
        {
            var a = atts.FirstOrDefault(x => x.Id == id);
            if (a is null) continue;
            if (a.MessageId is null)
            {
                // Fresh upload — claim it.
                a.MessageId = messageId;
                result.Add(a);
            }
            else
            {
                // Already parented (a FORWARD): clone the row, sharing the stored object.
                // Message deletion never removes storage, so the shared file is safe.
                var clone = new Attachment
                {
                    Id = Guid.NewGuid().ToString(),
                    MessageId = messageId,
                    Filename = a.Filename,
                    StoredAs = a.StoredAs,
                    MimeType = a.MimeType,
                    Size = a.Size,
                    Width = a.Width,
                    Height = a.Height,
                    DurationMs = a.DurationMs,
                    Waveform = a.Waveform,
                };
                db.Attachments.Add(clone);
                result.Add(clone);
            }
        }
        await db.SaveChangesAsync(ct);
        return result;
    }

    public async Task<IReadOnlyList<Attachment>> ListByMessageIdsAsync(IReadOnlyList<long> messageIds, CancellationToken ct = default)
    {
        if (messageIds.Count == 0) return Array.Empty<Attachment>();
        return await db.Attachments.AsNoTracking()
            .Where(a => a.MessageId != null && messageIds.Contains(a.MessageId.Value))
            .OrderBy(a => a.UploadedAt)
            .ToListAsync(ct);
    }
}
