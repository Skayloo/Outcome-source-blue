using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Voice;

// ── voice_leave ──────────────────────────────────────────────────────────────
public sealed record LeaveVoiceCommand(long UserId) : ICommand<long?>;
