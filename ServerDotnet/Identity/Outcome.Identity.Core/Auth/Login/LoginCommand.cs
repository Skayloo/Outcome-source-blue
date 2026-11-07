using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/login — sign in with email + login key (LoginKeys: the password stays on
/// the device), or, once, with the proof of an old password hash plus a new credential. Returns a JWT (in
/// <see cref="AuthResult"/>), or a partial token + 2FA challenge when TOTP is required.</summary>
/// Deliberately NOT an ICommand: TransactionBehavior rolls back everything written before a throw,
/// and a wrong password is answered by throwing — so the failure counter AccessFailedAsync had just
/// saved was undone every time, and the per-account lockout after 7 failures never armed. The
/// "banned user tried to log in" audit row went the same way. Each write here stands on its own.
/// <param name="Password">Only an out-of-date client sends it; it is refused (LoginKeys.RefuseRawPassword).</param>
public sealed record LoginCommand(string Email, string? Password, string? Device, string Ip,
    string? LoginKey = null, string? LegacyProof = null, LoginCredential? Credential = null) : IRequest<AuthResult>;
