using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Users;

// ── GET /api/v1/users/search ─────────────────────────────────────────────────
public sealed record SearchUsersQuery(string Query, long ExcludeUserId) : IQuery<IReadOnlyList<UserSearchDto>>;
