using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Voice;

public sealed class LeaveVoiceHandler(IVoiceStateRepository voice) : IRequestHandler<LeaveVoiceCommand, long?>
{
    public async Task<long?> Handle(LeaveVoiceCommand cmd, CancellationToken ct)
    {
        var current = await voice.GetAsync(cmd.UserId, ct);
        if (current is null) return null;
        await voice.ClearAsync(cmd.UserId, ct);
        return current.ChannelId;
    }
}
