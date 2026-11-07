using System.Security.Cryptography;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

/// <param name="Password">Only an out-of-date client sends it; it is refused (LoginKeys).</param>
public sealed record SetupCommand(string Email, string Username, string? Password, string? Device, string Ip, LoginCredential? Credential = null) : ICommand<SetupResult>;
