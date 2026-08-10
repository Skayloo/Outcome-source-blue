namespace Outcome.Domain.Entities;

/// <summary>
/// One user blocking another (directional; composite PK blocker+blocked). Blocking cuts every
/// direct path BOTH ways — DMs, calls, friend requests — regardless of which side initiates:
/// the pair simply can't interact until the block is lifted by the person who set it. Shared
/// channels stay visible; hiding the blocked user's messages there is the client's job.
/// App Review (UGC guideline 1.2) requires exactly this capability.
/// </summary>
public sealed class UserBlock
{
    public long BlockerId { get; set; }
    public long BlockedId { get; set; }
    public DateTime CreatedAt { get; set; }
}
