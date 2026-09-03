using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Outcome.Shared.Abstractions.Notifications;

namespace Outcome.Infrastructure.Notifications;

/// <summary>
/// Sends each notification through the transport that minted its token.
///
/// This exists because Android has two gateways and no way to pick between them from the token
/// alone: RuStore's own works wherever the RuStore app is installed and signed into, FCM works
/// wherever Google's services are. A device registers with whichever answers, tells us which one
/// it was, and this class honours that. Handing a token to the wrong gateway does not fail
/// loudly — it fails as a token that gateway has simply never heard of, which is indistinguishable
/// from an uninstalled app and would get the row deleted.
///
/// A transport nobody configured is not an error: the app keeps working and messages arrive over
/// the live socket, exactly as they did before any push existed.
/// </summary>
public sealed class PushRouter(IReadOnlyList<IPushSender> senders, ILogger<PushRouter> log) : IPushSender
{
    /// <summary>Transports already complained about, so an unconfigured one costs one line, not one per message.</summary>
    private readonly ConcurrentDictionary<string, bool> _warned = new();

    public bool Enabled => senders.Any(s => s.Enabled);

    public IReadOnlySet<string> Transports { get; } =
        senders.SelectMany(s => s.Transports).ToHashSet();

    private IPushSender? For(PushTarget target)
    {
        var sender = senders.FirstOrDefault(s => s.Enabled && s.Transports.Contains(target.Transport));
        if (sender is null && _warned.TryAdd(target.Transport, true))
            log.LogWarning(
                "no push transport configured for {Transport} — devices registered against it are unreachable while the app is closed",
                target.Transport);
        return sender;
    }

    public Task<PushOutcome> SendAsync(PushTarget target, PushMessage message, CancellationToken ct = default) =>
        For(target) is { } sender
            ? sender.SendAsync(target, message, ct)
            // Failed, not Gone: the device is fine, we are the ones who cannot reach it, and
            // deleting its row would lose the registration for when the transport is configured.
            : Task.FromResult(PushOutcome.Failed);

    public Task<PushOutcome> SendCallAsync(PushTarget target, CallPush call, CancellationToken ct = default) =>
        For(target) is { } sender
            ? sender.SendCallAsync(target, call, ct)
            : Task.FromResult(PushOutcome.Failed);
}
