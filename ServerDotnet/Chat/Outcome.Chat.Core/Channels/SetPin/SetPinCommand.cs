using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

// ── pin / unpin (ManageMessages) ─────────────────────────────────────────────
public sealed record SetPinCommand(long ChannelId, long MessageId, bool Pinned, long UserId, long Permissions, long RoleId) : ICommand;
