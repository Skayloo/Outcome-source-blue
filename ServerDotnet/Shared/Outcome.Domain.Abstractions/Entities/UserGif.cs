namespace Outcome.Domain.Entities;

/// <summary>
/// One GIF in a user's personal reaction library (W3GWG-25 stage 3). Uploaded by the user, kept
/// with the account — every device and every server they are on — and fired into a voice room as
/// a reaction (a LiveKit data message carrying <see cref="Path"/>). Deleting the row deletes the
/// file: nothing else points at it.
/// </summary>
public sealed class UserGif
{
    public long Id { get; set; }
    public long UserId { get; set; }
    /// <summary>The bare <c>/api/v1/files/&lt;id&gt;</c> path — no signature, no expiry, like an
    /// avatar: it is sent around in calls long after any signed URL would have lapsed.</summary>
    public string Path { get; set; } = "";
    /// <summary>The storage object behind <see cref="Path"/>, for the delete.</summary>
    public string FileId { get; set; } = "";
    public string Mime { get; set; } = "";
    public long Size { get; set; }
    public DateTime CreatedAt { get; set; }
}
