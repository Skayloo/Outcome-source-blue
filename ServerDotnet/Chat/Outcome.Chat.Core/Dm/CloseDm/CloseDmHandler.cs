using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Dm;

public sealed class CloseDmHandler(IDmRepository dms) : IRequestHandler<CloseDmCommand>
{
    public async Task Handle(CloseDmCommand cmd, CancellationToken ct)
    {
        if (!await dms.IsParticipantAsync(cmd.UserId, cmd.ChannelId, ct))
            throw DomainException.Forbidden("you are not a participant in this DM");
        await dms.CloseAsync(cmd.UserId, cmd.ChannelId, ct);
    }
}
