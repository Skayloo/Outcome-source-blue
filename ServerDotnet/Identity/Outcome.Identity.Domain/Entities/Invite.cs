namespace Outcome.Domain.Entities;

/// <summary>An invite code for registration.</summary>
public sealed class Invite
{
    public long Id { get; set; }
    public long ServerId { get; set; }
    public string Code { get; set; } = "";
    public long CreatedBy { get; set; }
    public long? RedeemedBy { get; set; }
    public int? MaxUses { get; set; }
    public int UseCount { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public bool Revoked { get; set; }
}
