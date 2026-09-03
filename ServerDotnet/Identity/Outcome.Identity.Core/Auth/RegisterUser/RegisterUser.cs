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

/// <param name="HostServerId">The space serving the subdomain the form was submitted from
/// (see /space-by-host). Without an invite it is what the new account joins — signing up on
/// coreotc.outcome.ru must land you in CoreOTC, not in an empty account.</param>
public sealed record RegisterUserCommand(string Email, string Username, string Password, string InviteCode, string? Device, string Ip, long? HostServerId = null, string? ConsentVersion = null)
    : ICommand<AuthResult>;
