namespace Outcome.Domain.Entities;

/// <summary>
/// A shareable no-login link into ONE voice channel ("come talk, no account needed").
/// The code is unguessable; the link grants a short-lived, audio-only LiveKit token after
/// the guest picks a display name — never an Outcome session. One active link per channel:
/// revoking kills the old code, the next create mints a fresh one (that's the rotation story).
/// </summary>
public sealed class GuestLink
{
    public long Id { get; set; }
    public string Code { get; set; } = "";
    public long ChannelId { get; set; }
    public long CreatedBy { get; set; }
    public bool Revoked { get; set; }
    public DateTime CreatedAt { get; set; }
}
