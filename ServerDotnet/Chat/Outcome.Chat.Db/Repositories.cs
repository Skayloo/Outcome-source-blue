using Outcome.Application.Channels;
using Outcome.Application.Dm;
using Outcome.Application.Search;
using Outcome.Application.Voice;
using Outcome.Domain.Entities;

namespace Outcome.Shared.Abstractions.Persistence;

public interface IDmRepository
{
    Task<long?> FindChannelAsync(long userA, long userB, CancellationToken ct = default);
    Task<long> CreateChannelAsync(long userA, long userB, CancellationToken ct = default);
    Task OpenAsync(long userId, long channelId, CancellationToken ct = default);
    Task CloseAsync(long userId, long channelId, CancellationToken ct = default);
    Task<bool> IsParticipantAsync(long userId, long channelId, CancellationToken ct = default);
    Task<IReadOnlyList<long>> GetParticipantIdsAsync(long channelId, CancellationToken ct = default);
    Task<IReadOnlyList<DmChannelInfoDto>> ListForUserAsync(long userId, CancellationToken ct = default);
}

public interface IChannelMuteRepository
{
    Task SetAsync(long userId, long channelId, bool muted, CancellationToken ct = default);
    Task<IReadOnlyList<long>> ListForUserAsync(long userId, CancellationToken ct = default);
}

public interface IReadStateRepository
{
    /// <summary>Marks the whole channel read (last_message_id := current max). Returns that id.</summary>
    Task<long> MarkReadAsync(long userId, long channelId, CancellationToken ct = default);

    /// <summary>Unread count per channel: messages after the user's read marker, not authored by them.</summary>
    Task<IReadOnlyDictionary<long, int>> UnreadCountsAsync(long userId, IReadOnlyCollection<long> channelIds, CancellationToken ct = default);

    /// <summary>Per channel: the furthest message id anyone OTHER than this user has read —
    /// drives the sender's ✓✓ ticks.</summary>
    Task<IReadOnlyDictionary<long, long>> MaxOtherReadAsync(long userId, IReadOnlyCollection<long> channelIds, CancellationToken ct = default);
}

public interface IVoiceListenRepository
{
    /// <summary>Marks a voice attachment as played by this user. Idempotent.</summary>
    Task MarkAsync(long userId, string attachmentId, CancellationToken ct = default);

    /// <summary>Which of these attachments this user has played.</summary>
    Task<IReadOnlySet<string>> ListenedSetAsync(long userId, IReadOnlyCollection<string> attachmentIds, CancellationToken ct = default);
}

public interface IChannelRepository
{
    Task<IReadOnlyList<Channel>> ListAsync(long serverId, CancellationToken ct = default);
    Task<Channel?> GetByIdAsync(long id, CancellationToken ct = default);
    Task<long> CreateAsync(Channel channel, CancellationToken ct = default);
    Task<bool> UpdateAsync(long id, string? name, string? topic, int? slowMode, int? position, bool? archived, CancellationToken ct = default);
    Task<bool> DeleteAsync(long id, CancellationToken ct = default);
}

public interface IChannelOverrideRepository
{
    /// <summary>
    /// Per-channel permission overrides for a role, as claim-name sets: channel id → (allow, deny).
    /// Effective channel permissions are <c>(base \ deny) ∪ allow</c>.
    /// </summary>
    Task<IReadOnlyDictionary<long, (IReadOnlySet<string> Allow, IReadOnlySet<string> Deny)>> GetForRoleAsync(long roleId, CancellationToken ct = default);
}

public interface IMessageRepository
{
    Task<IReadOnlyList<MessageDto>> GetForApiAsync(long channelId, long before, int limit, long requestingUserId, CancellationToken ct = default, bool pinnedOnly = false);
    Task<bool> SetPinnedAsync(long channelId, long messageId, bool pinned, CancellationToken ct = default);
    Task<IReadOnlyList<SearchRow>> SearchAsync(string query, long? channelId, int limit, CancellationToken ct = default);
    Task<(long Id, DateTime Timestamp)> CreateAsync(long channelId, long userId, string content, long? replyTo, string? forwardedFrom = null, CancellationToken ct = default);
    Task<Message?> GetByIdAsync(long id, CancellationToken ct = default);
    Task<DateTime?> EditAsync(long id, long userId, string content, CancellationToken ct = default);
    Task<bool> DeleteAsync(long id, long userId, bool isMod, CancellationToken ct = default);

    /// <summary>Physically REMOVE a message (DMs). A tombstone would leave the content —
    /// including E2EE ciphertext — sitting in the database after both parties erased it.</summary>
    Task<bool> PurgeAsync(long id, CancellationToken ct = default);
}

public interface IEmojiRepository
{
    Task<IReadOnlyList<Emoji>> ListAsync(CancellationToken ct = default);
    Task<bool> DeleteAsync(long id, CancellationToken ct = default);
}

public interface ISoundRepository
{
    Task<IReadOnlyList<Sound>> ListAsync(CancellationToken ct = default);
    Task<bool> DeleteAsync(long id, CancellationToken ct = default);
}

public interface IAttachmentRepository
{
    Task CreateAsync(Attachment attachment, CancellationToken ct = default);
    Task<Attachment?> GetByIdAsync(string id, CancellationToken ct = default);
    Task<IReadOnlyList<Attachment>> AttachToMessageAsync(IReadOnlyList<string> ids, long messageId, CancellationToken ct = default);
    Task<IReadOnlyList<Attachment>> ListByMessageIdsAsync(IReadOnlyList<long> messageIds, CancellationToken ct = default);
}

public interface IReactionRepository
{
    Task AddAsync(long messageId, long userId, string emoji, CancellationToken ct = default);
    Task RemoveAsync(long messageId, long userId, string emoji, CancellationToken ct = default);
}

public interface IVoiceStateRepository
{
    Task UpsertJoinAsync(long userId, long channelId, CancellationToken ct = default);
    Task ClearAsync(long userId, CancellationToken ct = default);
    Task<bool> ClearIfInChannelAsync(long userId, long channelId, CancellationToken ct = default);
    Task SetFlagAsync(long userId, VoiceFlag flag, bool value, CancellationToken ct = default);
    Task<VoiceStateDto?> GetAsync(long userId, CancellationToken ct = default);
    Task<IReadOnlyList<VoiceStateDto>> GetForChannelAsync(long channelId, CancellationToken ct = default);
    Task<IReadOnlyList<VoiceStateDto>> GetAllAsync(CancellationToken ct = default);
    /// <summary>Voice states for the READY payload: the server's channels + the user's own DM calls.</summary>
    Task<IReadOnlyList<VoiceStateDto>> GetForServerAsync(long serverId, long userId, CancellationToken ct = default);
    Task<int> CountForChannelAsync(long channelId, CancellationToken ct = default);
}
