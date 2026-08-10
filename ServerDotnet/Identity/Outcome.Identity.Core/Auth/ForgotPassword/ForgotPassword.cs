using MediatR;
using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/password/forgot — mails a reset code if the address has an account.
/// Returns nothing and never reveals whether the address exists (anti-enumeration).</summary>
public sealed record ForgotPasswordCommand(string Email) : ICommand;
