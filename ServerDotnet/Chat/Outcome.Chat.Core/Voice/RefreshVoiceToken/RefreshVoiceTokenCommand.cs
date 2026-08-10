using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Voice;

// ── voice_token_refresh ──────────────────────────────────────────────────────
public sealed record RefreshVoiceTokenCommand(long UserId, string Username, long Permissions, long RoleId, string SessionId)
    : ICommand<VoiceTokenResult?>;
