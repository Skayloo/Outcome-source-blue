using MediatR;
using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Auth;

/// <summary>POST /api/v1/auth/register/verify — completes a registration parked for email
/// verification: checks the mailed code against the pending entry and only then creates the
/// account. Device/Ip are captured at verify time (that's the session being opened).</summary>
public sealed record VerifyRegistrationCommand(string PartialToken, string Code, string? Device, string Ip, long? HostServerId = null)
    : ICommand<AuthResult>;
