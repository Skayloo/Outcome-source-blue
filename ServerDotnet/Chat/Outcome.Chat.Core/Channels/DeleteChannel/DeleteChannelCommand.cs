using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

// ── DELETE /api/v1/admin/channels/{id} ───────────────────────────────────────
public sealed record DeleteChannelCommand(long Id, long Permissions) : ICommand;
