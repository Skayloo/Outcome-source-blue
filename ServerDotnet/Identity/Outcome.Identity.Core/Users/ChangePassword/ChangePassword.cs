using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

// ── PUT /api/v1/users/me/password ────────────────────────────────────────────
/// <param name="CurrentPassword">Only an out-of-date client sends passwords; they are refused (LoginKeys).</param>
/// <param name="CurrentLoginKey">The current password's login key — absent when setting the first one.</param>
public sealed record ChangePasswordCommand(long UserId, string? CurrentPassword, string? NewPassword,
    string? CurrentLoginKey = null, LoginCredential? Credential = null) : ICommand;
