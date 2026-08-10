namespace Outcome.Domain.Entities;

/// <summary>A friendship (or pending friend request) between two users. The pair is stored
/// canonically with <see cref="UserLow"/> &lt; <see cref="UserHigh"/>; <see cref="RequestedBy"/>
/// records who initiated. <see cref="Status"/> is <c>"pending"</c> or <c>"accepted"</c>.</summary>
public sealed class Friendship
{
    public long Id { get; set; }
    public long UserLow { get; set; }
    public long UserHigh { get; set; }
    public long RequestedBy { get; set; }
    public string Status { get; set; } = "pending";
    public DateTime CreatedAt { get; set; }
}
