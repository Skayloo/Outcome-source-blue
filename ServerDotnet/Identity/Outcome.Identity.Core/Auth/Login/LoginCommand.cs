using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/login — sign in with email + password. Returns a JWT (in
/// <see cref="AuthResult"/>), or a partial token + 2FA challenge when TOTP/email-OTP is required.</summary>
public sealed record LoginCommand(string Email, string Password, string? Device, string Ip) : ICommand<AuthResult>;
