using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Auth;

/// <summary>DELETE /api/v1/auth/account — password-confirmed self-deletion with last-admin guard.</summary>
public sealed record DeleteAccountCommand(long UserId, string Password) : ICommand;
