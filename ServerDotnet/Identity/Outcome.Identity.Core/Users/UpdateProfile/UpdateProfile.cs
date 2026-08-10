using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

// ── PATCH /api/v1/users/me ───────────────────────────────────────────────────
public sealed record UpdateProfileCommand(long UserId, string? Username, string? Avatar, string? PublicKey = null, string? E2eeBackup = null, bool? PushPreview = null) : ICommand<MemberProfileDto>;
