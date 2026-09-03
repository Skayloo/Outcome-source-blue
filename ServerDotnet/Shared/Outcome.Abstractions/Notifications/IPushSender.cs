namespace Outcome.Shared.Abstractions.Notifications;

/// <summary>What the push gateway said about one delivery attempt.</summary>
public enum PushOutcome
{
    /// <summary>Accepted for delivery.</summary>
    Sent,
    /// <summary>Accepted, but only by the sandbox gateway — persist that on the token row.</summary>
    Sandbox,
    /// <summary>The token is dead (app deleted, or never valid). Delete the row.</summary>
    Gone,
    /// <summary>Transient or configuration problem; the token stays.</summary>
    Failed,
}

/// <summary>
/// One notification, as the phone will see it.
/// </summary>
/// <param name="Title">Who it is from.</param>
/// <param name="Body">What is shown if nothing else happens — the fallback the OS displays
/// when the device cannot, or will not, do better.</param>
/// <param name="RecipientId">Whose account this is going to. The device may be shared
/// between accounts.</param>
public sealed record PushMessage(
    string Title,
    string Body,
    long ChannelId,
    long RecipientId,
    /// <summary>Signed URL of one image from the message, shown in the banner itself. Null for
    /// anything that is not a picture: a notification cannot preview a zip.</summary>
    string? ImageUrl = null);

/// <summary>
/// An incoming call, on its way to a phone whose app is not running.
/// </summary>
/// <param name="CallId">Stable id for this call, so the phone can match a later cancellation
/// to the call it is currently ringing for.</param>
public sealed record CallPush(
    string CallId,
    long CallerId,
    string CallerName,
    string? CallerAvatar,
    long ChannelId,
    /// <summary>True when the caller gave up: the phone should stop ringing rather than start.</summary>
    bool Cancelled = false);

/// <summary>
/// One device to push to.
/// </summary>
/// <param name="Transport">Which gateway minted <paramref name="Token"/>. Routing keys on the
/// TRANSPORT rather than on the operating system, because Android has two of them — RuStore's
/// own and FCM — and a token issued by one is meaningless to the other. Persisted in
/// <c>device_tokens.platform</c>, whose pre-existing rows all read <c>ios</c>, so widening the
/// vocabulary needed no migration.</param>
/// <param name="Sandbox">APNs only: this token belongs to Apple's sandbox gateway. The other
/// transports have no such split and always pass false.</param>
public sealed record PushTarget(string Token, string Transport, bool Sandbox = false)
{
    /// <summary>Apple, via APNs. The historical value, which is why it is not called "apns".</summary>
    public const string Apns = "ios";
    /// <summary>RuStore's own transport, over vkpns.</summary>
    public const string RuStore = "rustore";
    /// <summary>Firebase Cloud Messaging.</summary>
    public const string Fcm = "fcm";
}

/// <summary>
/// Delivers a notification to one device. Implementations must not throw for a rejected
/// token — a bad device is a normal outcome, not an error the caller should handle.
/// </summary>
public interface IPushSender
{
    /// <summary>False when no push credentials are configured; callers skip the work entirely.</summary>
    bool Enabled { get; }

    /// <summary>
    /// Which <see cref="PushTarget.Transport"/> values this sender can deliver to. A sender is
    /// asked about nothing else — handing an APNs token to the RuStore gateway would not fail
    /// loudly, it would fail as a token the gateway has simply never heard of.
    /// </summary>
    IReadOnlySet<string> Transports { get; }

    Task<PushOutcome> SendAsync(PushTarget target, PushMessage message, CancellationToken ct = default);

    /// <summary>
    /// Rings a phone. This is a different kind of push entirely: it is delivered to a separate
    /// token, wakes the app rather than drawing a banner, and iOS requires the app to answer it
    /// by showing the system call screen — so it must only ever be sent for a real call.
    /// </summary>
    Task<PushOutcome> SendCallAsync(PushTarget target, CallPush call, CancellationToken ct = default);
}
