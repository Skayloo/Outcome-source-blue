using Newtonsoft.Json;
using Outcome.Domain.Entities;

namespace Outcome.Application.Auth;

/// <summary>User shape returned by auth endpoints (serialized snake_case).</summary>
public sealed record UserDto(
    long Id,
    string Username,
    string Email,
    string? Avatar,
    string Status,
    long RoleId,
    bool TotpEnabled,
    DateTime CreatedAt,
    /// <summary>False ⇒ SSO-only account with no password of its own: the client must offer a
    /// separate E2EE backup passphrase, since there is no password to wrap the key backup with.</summary>
    bool PasswordSet = true);

/// <summary>Login/register result. token/partial_token/user are omitted when null (Go omitempty).</summary>
public sealed class AuthResult
{
    [JsonProperty("token", NullValueHandling = NullValueHandling.Ignore)]
    public string? Token { get; init; }

    [JsonProperty("partial_token", NullValueHandling = NullValueHandling.Ignore)]
    public string? PartialToken { get; init; }

    [JsonProperty("requires_2fa")]
    public bool Requires2fa { get; init; }

    /// <summary>Registration parked pending an email code; complete via /auth/register/verify
    /// with <see cref="PartialToken"/>. Omitted (false) on every pre-existing response shape.</summary>
    [JsonProperty("requires_email_verify", DefaultValueHandling = DefaultValueHandling.Ignore)]
    public bool RequiresEmailVerify { get; init; }

    /// <summary>Which 2FA method to complete: "totp" or "email". Set only when requires_2fa.</summary>
    [JsonProperty("two_factor_method", NullValueHandling = NullValueHandling.Ignore)]
    public string? TwoFactorMethod { get; init; }

    [JsonProperty("user", NullValueHandling = NullValueHandling.Ignore)]
    public UserDto? User { get; init; }
}

public static class UserMapper
{
    public static UserDto ToDto(User u) =>
        new(u.Id, u.Username, u.Email ?? "", string.IsNullOrEmpty(u.Avatar) ? null : u.Avatar, u.Status, u.RoleId, u.TotpSecret is not null, u.CreatedAt, u.PasswordSet);
}
