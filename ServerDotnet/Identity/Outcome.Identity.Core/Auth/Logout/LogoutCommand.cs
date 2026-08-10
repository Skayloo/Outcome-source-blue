using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

// ── POST /api/v1/auth/logout ─────────────────────────────────────────────────
public sealed record LogoutCommand : ICommand;
