using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Voice;

// ── voice_join ───────────────────────────────────────────────────────────────
/// <param name="Rejoin">The client is re-announcing a call it is still in (after a reconnect),
/// not starting one: its mute/camera flags stand.</param>
public sealed record JoinVoiceCommand(long ChannelId, long UserId, string Username, long Permissions, long RoleId, string SessionId, bool Rejoin = false)
    : ICommand<JoinVoiceResult>;
