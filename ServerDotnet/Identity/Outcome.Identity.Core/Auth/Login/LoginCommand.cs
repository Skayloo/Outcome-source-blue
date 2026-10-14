using MediatR;
using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/login — sign in with email + password. Returns a JWT (in
/// <see cref="AuthResult"/>), or a partial token + 2FA challenge when TOTP/email-OTP is required.</summary>
/// Deliberately NOT an ICommand: TransactionBehavior rolls back everything written before a throw,
/// and a wrong password is answered by throwing — so the failure counter AccessFailedAsync had just
/// saved was undone every time, and the per-account lockout after 7 failures never armed. The
/// "banned user tried to log in" audit row went the same way. Each write here stands on its own.
public sealed record LoginCommand(string Email, string Password, string? Device, string Ip) : IRequest<AuthResult>;
