using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/verify-totp — completes a 2FA challenge and issues a session.</summary>
public sealed record VerifyTotpCommand(string PartialToken, string Code) : ICommand<AuthResult>;
