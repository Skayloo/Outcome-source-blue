using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

// ── PATCH /api/v1/admin/channels/{id} ────────────────────────────────────────
public sealed record UpdateChannelCommand(long Id, string? Name, string? Topic, int? SlowMode, int? Position, bool? Archived, long Permissions)
    : ICommand<ChannelDto>;
