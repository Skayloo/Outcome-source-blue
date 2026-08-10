using MediatR;
using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/password/reset — completes a reset with the mailed code, sets the new
/// password (works for SSO-only accounts too — no current password needed) and logs the user in.</summary>
public sealed record ResetPasswordCommand(string Email, string Code, string NewPassword, string? Device, string Ip)
    : ICommand<AuthResult>;
