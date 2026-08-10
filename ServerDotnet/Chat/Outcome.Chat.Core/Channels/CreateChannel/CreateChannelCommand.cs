using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

// ── POST /api/v1/admin/channels ──────────────────────────────────────────────
public sealed record CreateChannelCommand(string Name, string Type, string Category, string Topic, int Position, long Permissions)
    : ICommand<ChannelDto>;
