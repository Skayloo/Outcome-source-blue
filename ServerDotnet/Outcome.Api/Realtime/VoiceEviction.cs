using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Voice;

namespace Outcome.Api.Realtime;

/// <summary>
/// Takes people OUT of a call, for real. Closing someone's socket clears their voice_states row
/// (after the reconnect grace), but their LiveKit session is a separate connection holding a token
/// that was valid when issued — a banned, deleted or removed member went on hearing and talking
/// in the room until they hung up themselves. This removes the row AND every LiveKit session of the
/// user, and tells the room. Never throws: the action that called it already happened.
/// </summary>
public sealed class VoiceEviction(
    IVoiceStateRepository voice, IChannelRepository channels, ILiveKitRoomService rooms,
    IConnectionRegistry registry, IGuestLinkRepository guestLinks, ILogger<VoiceEviction> logger)
{
    /// <summary>Out of whatever call <paramref name="userId"/> is in — or, with
    /// <paramref name="onlyServerId"/>, only if that call is in one of that server's rooms
    /// (removed from one server, they keep a call elsewhere).</summary>
    public async Task EvictUserAsync(long userId, long? onlyServerId = null, CancellationToken ct = default)
    {
        try
        {
            var state = await voice.GetAsync(userId, ct);
            if (state is null) return;
            var channel = await channels.GetByIdAsync(state.ChannelId, ct);
            if (onlyServerId is { } only && channel?.ServerId != only) return;
            await RemoveAsync(state.ChannelId, channel?.ServerId, [userId], ct);
        }
        catch (Exception ex) { logger.LogWarning(ex, "voice eviction failed for user {UserId}", userId); }
    }

    /// <summary>Everyone, guests included, out of every room of a server that is being deleted.</summary>
    public async Task EvictServerAsync(long serverId, CancellationToken ct = default)
    {
        try
        {
            foreach (var channel in await channels.ListAsync(serverId, ct))
            {
                if (channel.Type != "voice") continue;
                var people = (await voice.GetForChannelAsync(channel.Id, ct)).Select(s => s.UserId).ToList();
                // LiveKit may hold sessions the table has already forgotten (a row dropped by the
                // disconnect grace while the media connection lived on).
                foreach (var id in await rooms.ListConnectedUserIdsAsync(channel.Id, ct))
                    if (!people.Contains(id)) people.Add(id);
                await RemoveAsync(channel.Id, serverId, people, ct);
                await rooms.RemoveGuestsAsync(channel.Id, ct);
            }
        }
        catch (Exception ex) { logger.LogWarning(ex, "voice eviction failed for server {ServerId}", serverId); }
    }

    /// <summary>Everyone, guests included, out of ONE room that is being deleted — taken before the
    /// delete, because every lookup afterwards skips a deleted channel and could never find it again.
    /// Its guest link dies with it, so the guests' tokens open nothing on the way back.</summary>
    public async Task EvictRoomAsync(long channelId, long? serverId, CancellationToken ct = default)
    {
        try
        {
            var people = (await voice.GetForChannelAsync(channelId, ct)).Select(s => s.UserId).ToList();
            foreach (var id in await rooms.ListConnectedUserIdsAsync(channelId, ct))
                if (!people.Contains(id)) people.Add(id);
            await RemoveAsync(channelId, serverId, people, ct);
            await rooms.RemoveGuestsAsync(channelId, ct);
            await guestLinks.RevokeAsync(channelId, ct);
        }
        catch (Exception ex) { logger.LogWarning(ex, "voice eviction failed for room {ChannelId}", channelId); }
    }

    private async Task RemoveAsync(long channelId, long? serverId, IReadOnlyList<long> userIds, CancellationToken ct)
    {
        foreach (var id in userIds)
        {
            await voice.ClearIfInChannelAsync(id, channelId, ct);
            await rooms.RemoveParticipantAsync(channelId, id, ct);
        }
        foreach (var id in userIds)
        {
            var frame = WsFrames.VoiceLeave(channelId, id);
            if (serverId is { } sid) await registry.BroadcastToServerAsync(sid, frame);
            // A DM call (and members looking at another server) hear it from the room itself.
            foreach (var left in await voice.GetForChannelAsync(channelId, ct))
                await registry.SendToUserAsync(left.UserId, frame);
        }
    }
}
