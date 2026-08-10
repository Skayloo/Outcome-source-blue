using Outcome.Domain.Entities;

namespace Outcome.Shared.Abstractions.Persistence;

/// <summary>A voice channel of the server plus its active guest link (null when none).</summary>
public sealed record GuestLinkInfo(long ChannelId, string ChannelName, string? Code);

/// <summary>Shareable no-login voice links (see <see cref="GuestLink"/>). One active per channel.</summary>
public interface IGuestLinkRepository
{
    /// <summary>Every VOICE channel of the server with its active link, if it has one — the
    /// server-management view (a channel without a link simply has a null code).</summary>
    Task<IReadOnlyList<GuestLinkInfo>> ListForServerAsync(long serverId, CancellationToken ct = default);

    /// <summary>The channel's active link, or a freshly minted one if none exists.</summary>
    Task<GuestLink> GetOrCreateAsync(long channelId, long createdBy, CancellationToken ct = default);

    /// <summary>Active (non-revoked) link by code, or null.</summary>
    Task<GuestLink?> GetByCodeAsync(string code, CancellationToken ct = default);

    /// <summary>The channel's active (non-revoked) guest link CODE, or null. Read-only — unlike
    /// GetOrCreateAsync it never mints one.</summary>
    Task<string?> GetActiveCodeForChannelAsync(long channelId, CancellationToken ct = default);

    /// <summary>Revoke the channel's active link. False when there was none.</summary>
    Task<bool> RevokeAsync(long channelId, CancellationToken ct = default);

    /// <summary>Ids of every channel with an active guest link — the channels whose LiveKit rooms
    /// may hold guests (used to rebuild the guest-presence registry after a server restart).</summary>
    Task<IReadOnlyList<long>> ListActiveChannelIdsAsync(CancellationToken ct = default);
}
