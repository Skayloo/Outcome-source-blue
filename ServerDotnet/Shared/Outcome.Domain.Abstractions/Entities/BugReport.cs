namespace Outcome.Domain.Entities;

/// <summary>
/// A bug report submitted by any user via the "Send To Developer" panel. The instance owner
/// (Administrator) triages these: reads them, views the attached screenshots inline, and moves
/// them through the <see cref="Status"/> lifecycle. Screenshots are stored as public
/// <c>/api/v1/files/{id}</c> URLs (reusing the message-attachment upload pipeline).
/// </summary>
public sealed class BugReport
{
    /// <summary>Report lifecycle states (kept in sync with the client status filter).</summary>
    public const string StatusNew = "new";
    public const string StatusInProgress = "in_progress";
    public const string StatusFixed = "fixed";

    public long Id { get; set; }
    public long ReporterId { get; set; }
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public string Status { get; set; } = StatusNew;
    /// <summary>Public URLs of attached screenshots (<c>/api/v1/files/{id}</c>). Mapped to text[].</summary>
    public List<string> Attachments { get; set; } = new();
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    public static bool IsValidStatus(string? s) =>
        s is StatusNew or StatusInProgress or StatusFixed;
}
