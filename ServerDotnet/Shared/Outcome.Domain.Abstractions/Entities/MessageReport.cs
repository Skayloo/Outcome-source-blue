namespace Outcome.Domain.Entities;

/// <summary>
/// A user's report of an objectionable message — the moderation inbox App Review (UGC
/// guideline 1.2) demands. The message text is SNAPSHOTTED at report time: the author can
/// edit or delete the original afterwards, and the moderator must still see what was
/// actually reported.
/// </summary>
public sealed class MessageReport
{
    public const string StatusOpen = "open";
    public const string StatusResolved = "resolved";
    public const string StatusDismissed = "dismissed";
    /// <summary>Dealt with, for good. Set by an ACTION — the message was hidden, removed, or
    /// the complaint was answered — and nothing moves a report back out of it. The other three
    /// are labels a moderator flips between; this one records that something happened, and a
    /// queue where handled items can drift back to "open" is a queue nobody trusts.</summary>
    public const string StatusClosed = "closed";

    public long Id { get; set; }
    public long ReporterId { get; set; }
    public long MessageId { get; set; }
    /// <summary>Author of the reported message at report time (survives message deletion).</summary>
    public long AuthorId { get; set; }
    /// <summary>Snapshot of the message content at report time.</summary>
    public string Content { get; set; } = "";
    /// <summary>Which server the reported message lived in, snapshotted like the content and
    /// the author — the message may be deleted, and a complaint nobody can attribute to a
    /// server is a complaint no server moderator can be shown. Null for a direct message,
    /// which belongs to no server and is the instance owner's business alone.</summary>
    public long? ServerId { get; set; }
    /// <summary>The channel it was in, so an action can be scoped and a reply can point at it.</summary>
    public long ChannelId { get; set; }
    public string Reason { get; set; } = "";
    public string Status { get; set; } = StatusOpen;
    public DateTime CreatedAt { get; set; }

    public static bool IsValidStatus(string? s) =>
        s is StatusOpen or StatusResolved or StatusDismissed or StatusClosed;

    /// <summary>A status a moderator may set by hand. Closing happens by ACTING, not by picking
    /// it from a list, and nothing may set a closed report back to anything else.</summary>
    public static bool IsSettableByHand(string? s) =>
        s is StatusOpen or StatusResolved or StatusDismissed;
}
