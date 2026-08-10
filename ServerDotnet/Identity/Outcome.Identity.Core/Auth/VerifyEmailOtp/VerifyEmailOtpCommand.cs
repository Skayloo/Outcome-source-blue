using System.Security.Cryptography;
using System.Text;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/verify-email-otp — completes an email 2FA challenge and issues a JWT.</summary>
public sealed record VerifyEmailOtpCommand(string PartialToken, string Code) : ICommand<AuthResult>;
