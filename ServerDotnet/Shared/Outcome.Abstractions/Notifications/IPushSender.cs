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
/// <param name="RecipientId">Whose account this is going to. The device may be shared between
/// accounts, and each has its own encryption key.</param>
/// <param name="Encrypted">The untouched end-to-end envelope. The server cannot open it; it is
/// carried so the recipient's device can, and replace <paramref name="Body"/> with the real
/// text. Null when there is nothing to decrypt, when the user asked for no previews, or when
/// the envelope would not fit in a push.</param>
/// <param name="SenderKey">The sender's public key, without which the envelope cannot be
/// opened.</param>
public sealed record PushMessage(
    string Title,
    string Body,
    long ChannelId,
    long RecipientId,
    string? Encrypted = null,
    string? SenderKey = null,
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
/// Delivers a notification to one device. Implementations must not throw for a rejected
/// token — a bad device is a normal outcome, not an error the caller should handle.
/// </summary>
public interface IPushSender
{
    /// <summary>False when no push credentials are configured; callers skip the work entirely.</summary>
    bool Enabled { get; }

    Task<PushOutcome> SendAsync(string deviceToken, bool sandbox, PushMessage message, CancellationToken ct = default);

    /// <summary>
    /// Rings a phone. This is a different kind of push entirely: it is delivered to a separate
    /// token, wakes the app rather than drawing a banner, and iOS requires the app to answer it
    /// by showing the system call screen — so it must only ever be sent for a real call.
    /// </summary>
    Task<PushOutcome> SendCallAsync(string voipToken, bool sandbox, CallPush call, CancellationToken ct = default);
}
