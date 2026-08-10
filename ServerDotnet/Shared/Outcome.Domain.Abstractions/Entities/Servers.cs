namespace Outcome.Domain.Entities;

/// <summary>A tenant server (community). Channels/roles/invites belong to one server.</summary>
public sealed class Server
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public long OwnerId { get; set; }
    public string? Icon { get; set; }
    public bool Deleted { get; set; }
    public DateTime CreatedAt { get; set; }
    /// <summary>Listed in the public "Explore" directory + joinable without an invite.</summary>
    public bool IsPublic { get; set; }
    /// <summary>Short blurb shown in the Explore directory.</summary>
    public string Description { get; set; } = "";
    /// <summary>Optional custom domain (e.g. <c>chat.community.com</c>) that lands on this space.
    /// Unique, lowercase, host-only. Null ⇒ no custom domain (paid feature). Auto-maps to
    /// column <c>custom_domain</c>.</summary>
    public string? CustomDomain { get; set; }
}

/// <summary>Membership of a user in a server, with their per-server role.</summary>
public sealed class ServerMember
{
    public long ServerId { get; set; }
    public long UserId { get; set; }
    public long? RoleId { get; set; }
    public DateTime JoinedAt { get; set; }
}
