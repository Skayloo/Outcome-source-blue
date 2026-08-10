namespace Outcome.Application.Users;

/// <summary>A user match returned by the directory search (GET /api/v1/users/search).</summary>
public sealed record UserSearchDto(long Id, string Username, string? Avatar, string Status);
