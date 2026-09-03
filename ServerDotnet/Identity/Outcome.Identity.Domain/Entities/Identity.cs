using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.AspNetCore.Identity;

namespace Outcome.Domain.Entities;

/// <summary>
/// A registered user. Extends <see cref="IdentityUser{TKey}"/> so ASP.NET Core Identity
/// (UserManager, PasswordHasher, lockout) owns auth; <c>PasswordHash</c>/<c>UserName</c>/<c>Email</c>
/// are inherited. Domain-specific fields (single <see cref="RoleId"/>, status, TOTP, ban) are added.
/// </summary>
public sealed class User : IdentityUser<long>
{
    public string? Avatar { get; set; }
    public long RoleId { get; set; } = 4;
    public string? TotpSecret { get; set; }

    /// <summary>Did the USER choose their password? False for accounts created via SSO, which
    /// get an unguessable random one they never learn. It decides whether the E2EE key backup
    /// can be wrapped with the password (it can, for everyone who knows theirs) or needs a
    /// separate backup passphrase (SSO-only accounts — otherwise there is no secret to wrap it
    /// with). Setting a password later flips it to true.</summary>
    public bool PasswordSet { get; set; } = true;
    /// <summary>Show the message itself on the lock screen, or just who sent it. On by default,
    /// because a notification you cannot read is barely a notification. Lives on the account
    /// rather than the device: someone who wants previews off wants them off everywhere.</summary>
    public bool PushPreview { get; set; } = true;
    public string Status { get; set; } = "offline";
    public DateTime CreatedAt { get; set; }
    public DateTime? LastSeen { get; set; }
    public bool Banned { get; set; }
    public bool Deleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public string? BanReason { get; set; }
    public DateTime? BanExpires { get; set; }

    /// <summary>When this account's owner accepted the personal-data consent, and WHICH text
    /// they accepted. Both halves matter: a stored "true" proves nothing a year later, when the
    /// document has been reworded twice and nobody can say which version was on screen.
    ///
    /// The version travels from the client rather than being stamped server-side, because the
    /// client is what actually displayed it — an older build showing an older text should be
    /// recorded honestly as that older text. Absent (an app predating this field), the server's
    /// current version is recorded instead, which is the truthful reading of "whatever was
    /// published at the time".</summary>
    public DateTime? ConsentAt { get; set; }
    public string? ConsentVersion { get; set; }

    /// <summary>C#-side alias for Identity's <see cref="IdentityUser{TKey}.UserName"/>. Not mapped —
    /// EF LINQ must use <c>UserName</c>; materialized C# code may use this.</summary>
    [NotMapped]
    public string Username
    {
        get => UserName ?? "";
        set => UserName = value;
    }
}

/// <summary>A permission role. Extends <see cref="IdentityRole{TKey}"/>; <see cref="Permissions"/>
/// is the int64 bitfield (we keep a single role per user via <see cref="User.RoleId"/>, not
/// Identity's user-role join).</summary>
public sealed class Role : IdentityRole<long>
{
    public string? Color { get; set; }
    public long Permissions { get; set; }
    public int Position { get; set; }
    public bool IsDefault { get; set; }
}

/// <summary>An auth session. <see cref="Token"/> stores the SHA-256 hash of the raw bearer token.</summary>
public sealed class Session
{
    public long Id { get; set; }
    public long UserId { get; set; }
    public string Token { get; set; } = "";
    public string? Device { get; set; }
    public string? IpAddress { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime LastUsed { get; set; }
    public DateTime ExpiresAt { get; set; }
}

/// <summary>Audit row for login attempts (used for diagnostics/rate-limit history).</summary>
public sealed class LoginAttempt
{
    public long Id { get; set; }
    public string IpAddress { get; set; } = "";
    public string? Username { get; set; }
    public bool Success { get; set; }
    public DateTime Timestamp { get; set; }
}

/// <summary>
/// One push destination — an APNs (or later FCM) token for one of a user's devices. Lives in
/// the SPACE's database like everything else keyed by user id: the same phone signed into two
/// spaces registers two rows, which is correct, since the two accounts are unrelated.
/// </summary>
public sealed class DeviceToken
{
    public long Id { get; set; }
    public long UserId { get; set; }
    /// <summary>Hex APNs device token, as the OS handed it to the app.</summary>
    public string Token { get; set; } = "";
    public string Platform { get; set; } = "ios";
    /// <summary>
    /// <c>alert</c> for messages, <c>voip</c> for incoming calls. Apple issues these from two
    /// different registries and refuses to accept one where it expects the other, so a device
    /// registers both and they must never be mixed up.
    /// </summary>
    public string Kind { get; set; } = "alert";
    /// <summary>Apple's sandbox gateway, i.e. a build signed with a development profile. The
    /// app cannot tell reliably, so this starts false and is corrected the first time the
    /// production gateway rejects the token as unknown.</summary>
    public bool Sandbox { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime LastSeen { get; set; }
}
