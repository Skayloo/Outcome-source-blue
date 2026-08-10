using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Users;

/// <summary>GET /api/v1/users/me/permissions — the caller's effective permission strings
/// (their role's claims UNION their direct user claims), claim-based like api_mobstra_analytics.</summary>
public sealed record GetMyPermissionsQuery(long UserId) : IQuery<IReadOnlyList<string>>;
