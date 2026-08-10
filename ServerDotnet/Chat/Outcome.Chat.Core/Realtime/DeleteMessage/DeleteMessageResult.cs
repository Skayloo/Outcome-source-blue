using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Realtime;

/// <param name="Purged">The row was REMOVED, not tombstoned (DMs) — clients drop the
/// message entirely instead of rendering "message deleted".</param>
/// <param name="DmParticipantIds">Recipients for a DM deletion. A DM has no server, so a
/// server-wide broadcast would reach nobody and the peer would keep showing a message that
/// no longer exists.</param>
public sealed record DeletedMessage(
    long MessageId,
    long ChannelId,
    bool Purged = false,
    IReadOnlyList<long>? DmParticipantIds = null);
