using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Auth;

/// <param name="HostServerId">The server whose own custom domain the form was submitted from.
/// Without an invite it is what the new account joins — signing up on a server's own address
/// must land you in that server, not in an empty account.</param>
public sealed record RegisterUserCommand(string Email, string Username, string Password, string InviteCode, string? Device, string Ip, long? HostServerId = null, string? ConsentVersion = null)
    : ICommand<AuthResult>;
