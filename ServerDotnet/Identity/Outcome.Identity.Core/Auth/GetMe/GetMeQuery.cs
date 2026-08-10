using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

// ── GET /api/v1/auth/me ──────────────────────────────────────────────────────
public sealed record GetMeQuery : IQuery<UserDto>;
