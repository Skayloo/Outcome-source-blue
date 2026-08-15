using System.Text.RegularExpressions;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Realtime;

/// <summary>
/// Decides who deserves a push for a new message, and sends it.
///
/// Deliberately narrow: a direct message, or being named in a channel. Pushing every channel
/// message would make the phone useless within a day, and the user can already see everything
/// they missed when they open the app.
///
/// Called fire-and-forget from the socket handler, so it owns its scope and swallows its own
/// failures — a push that doesn't arrive must never cost anyone a message.
/// </summary>
public sealed partial class PushNotifier(
    IPushSender push,
    IConnectionHub hub,
    IServiceScopeFactory scopeFactory,
    ILogger<PushNotifier> logger)
{
    // Same shape the web client highlights, except \w here also covers Cyrillic — which is
    // what we want, since usernames may be.
    [GeneratedRegex(@"@([\w.\-]{2,32})", RegexOptions.CultureInvariant)]
    private static partial Regex MentionRegex { get; }

    private const int MaxBodyChars = 180;
    /// <summary>What an end-to-end encrypted direct message looks like from the server: an
    /// envelope it cannot open. Mirrors MARKER in the clients' e2ee modules.</summary>
    private const string E2eeMarker = "oce2ee:v1:";
    private const string NoPreview = "Новое сообщение";
    /// <summary>Apple caps an alert push at 4 KB, and the envelope is by far the largest thing
    /// in ours. Past this the push is sent without it and the phone shows the fallback — a long
    /// message loses its preview rather than the notification failing to arrive.</summary>
    private const int MaxEnvelopeChars = 3200;

    public void QueueMessage(Space space, long channelId, long senderId, string senderName, string content,
        string? imageUrl,
        IReadOnlyList<long>? dmParticipants, long? serverId)
    {
        if (!push.Enabled) return;
        // The overwhelming majority of channel traffic mentions nobody. Rule it out here
        // rather than opening a database scope per message to find that out.
        if (dmParticipants is null && !content.Contains('@')) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await NotifyAsync(space, channelId, senderId, senderName, content, imageUrl, dmParticipants, serverId);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "push notification for channel {ChannelId} failed", channelId);
            }
        });
    }

    /// <summary>
    /// Ring a phone whose app is not running. Unlike a message push this one is not optional
    /// courtesy: without it, calling someone whose app is closed simply does nothing, and the
    /// caller waits out the ring window for no reason.
    /// </summary>
    public void QueueCall(Space space, long calleeId, CallPush call)
    {
        if (!push.Enabled) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScopeFor(space);
                var devices = scope.ServiceProvider.GetRequiredService<IDeviceTokenRepository>();
                foreach (var d in await devices.ListForUsersAsync([calleeId], "voip"))
                {
                    var outcome = await push.SendCallAsync(d.Token, d.Sandbox, call);
                    if (outcome == PushOutcome.Gone) await devices.RemoveAsync(d.Token);
                    else if (outcome == PushOutcome.Sandbox) await devices.MarkSandboxAsync(d.Token);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "call push to user {UserId} failed", calleeId);
            }
        });
    }

    private async Task NotifyAsync(Space space, long channelId, long senderId, string senderName, string content,
        string? imageUrl,
        IReadOnlyList<long>? dmParticipants, long? serverId)
    {
        await using var scope = scopeFactory.CreateAsyncScopeFor(space);
        var sp = scope.ServiceProvider;

        List<long> candidates;
        if (dmParticipants is not null)
            candidates = dmParticipants.Where(p => p != senderId).ToList();
        else if (serverId is { } sid)
            candidates = await MentionedMembersAsync(sp, sid, senderId, content);
        else
            return;

        // Someone with a live socket is already being told, on this device or another.
        candidates.RemoveAll(id => hub.IsOnline(space.Id, id));
        if (candidates.Count == 0) return;

        var mutes = sp.GetRequiredService<IChannelMuteRepository>();
        var muted = new HashSet<long>();
        foreach (var id in candidates)
            if ((await mutes.ListForUserAsync(id)).Contains(channelId))
                muted.Add(id);
        candidates.RemoveAll(muted.Contains);
        if (candidates.Count == 0) return;

        // Whether the text itself may appear is the RECIPIENT's setting, not the sender's, so
        // it is resolved per person rather than once for the message.
        var users = sp.GetRequiredService<IUserRepository>();
        var preview = new Dictionary<long, bool>();
        foreach (var id in candidates)
            preview[id] = (await users.GetByIdAsync(id))?.PushPreview ?? true;

        // An encrypted message travels as-is, for the recipient's device to open. We carry the
        // sender's key with it because the envelope is useless without it — and the phone, on a
        // lock screen with no network guarantee, is in no position to go and fetch it.
        var encrypted = content.StartsWith(E2eeMarker, StringComparison.Ordinal);
        string? senderKey = null;
        if (encrypted && content.Length <= MaxEnvelopeChars)
            senderKey = (await users.GetByIdAsync(senderId))?.PublicKey;

        var devices = sp.GetRequiredService<IDeviceTokenRepository>();
        var tokens = await devices.ListForUsersAsync(candidates);
        foreach (var d in tokens)
        {
            var wantsText = preview.GetValueOrDefault(d.UserId, true);
            var message = new PushMessage(
                senderName,
                wantsText ? Preview(content) : NoPreview,
                channelId,
                d.UserId,
                // Only when they asked to see message text: someone who turned previews off
                // does not want their device quietly putting the words back.
                wantsText ? (senderKey is null ? null : content) : null,
                wantsText ? senderKey : null,
                // A preview the recipient asked not to see should not arrive as a picture either.
                wantsText ? imageUrl : null);

            var outcome = await push.SendAsync(d.Token, d.Sandbox, message);
            if (outcome == PushOutcome.Gone) await devices.RemoveAsync(d.Token);
            else if (outcome == PushOutcome.Sandbox) await devices.MarkSandboxAsync(d.Token);
        }
    }

    /// <summary>Users named with @ in the text who are actually members of this server.</summary>
    private static async Task<List<long>> MentionedMembersAsync(IServiceProvider sp, long serverId, long senderId, string content)
    {
        var names = MentionRegex.Matches(content).Select(m => m.Groups[1].Value).Distinct(StringComparer.OrdinalIgnoreCase).Take(16).ToList();
        if (names.Count == 0) return [];

        var users = sp.GetRequiredService<IUserRepository>();
        var servers = sp.GetRequiredService<IServerRepository>();
        var found = new List<long>();
        foreach (var name in names)
        {
            var user = await users.GetByUsernameAsync(name);
            if (user is null || user.Id == senderId || user.Banned || user.Deleted) continue;
            if (await servers.IsMemberAsync(serverId, user.Id)) found.Add(user.Id);
        }
        return found;
    }

    /// <summary>
    /// The message as it may appear on a lock screen.
    ///
    /// An end-to-end encrypted direct message cannot appear at all: what reached this server is
    /// an envelope only the recipient's device can open. Showing the base64 would be worse than
    /// showing nothing, so it reads the same as a preview the user switched off. Putting real
    /// text there needs a notification service extension that decrypts on the phone.
    /// </summary>
    private static string Preview(string content)
    {
        var text = content.Trim();
        if (text.Length == 0) return "Вложение";
        if (text.StartsWith(E2eeMarker, StringComparison.Ordinal)) return NoPreview;
        return text.Length <= MaxBodyChars ? text : text[..MaxBodyChars] + "…";
    }
}
