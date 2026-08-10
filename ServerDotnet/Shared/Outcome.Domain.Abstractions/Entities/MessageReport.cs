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

    public long Id { get; set; }
    public long ReporterId { get; set; }
    public long MessageId { get; set; }
    /// <summary>Author of the reported message at report time (survives message deletion).</summary>
    public long AuthorId { get; set; }
    /// <summary>Snapshot of the message content at report time.</summary>
    public string Content { get; set; } = "";
    public string Reason { get; set; } = "";
    public string Status { get; set; } = StatusOpen;
    public DateTime CreatedAt { get; set; }

    public static bool IsValidStatus(string? s) =>
        s is StatusOpen or StatusResolved or StatusDismissed;
}
