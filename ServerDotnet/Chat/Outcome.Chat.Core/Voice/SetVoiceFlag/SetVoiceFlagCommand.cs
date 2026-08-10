using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Voice;

// ── voice_mute / deafen / camera / screenshare ───────────────────────────────
public sealed record SetVoiceFlagCommand(long UserId, VoiceFlag Flag, bool Value, long Permissions, long RoleId)
    : ICommand<VoiceStateDto?>;
