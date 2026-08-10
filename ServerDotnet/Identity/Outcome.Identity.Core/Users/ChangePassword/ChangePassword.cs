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
public sealed record ChangePasswordCommand(long UserId, string CurrentPassword, string NewPassword) : ICommand;
