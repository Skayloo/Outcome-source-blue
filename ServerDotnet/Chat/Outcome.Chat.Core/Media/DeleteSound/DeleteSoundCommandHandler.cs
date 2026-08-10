using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Media;

public sealed class DeleteSoundHandler(ISoundRepository sounds) : IRequestHandler<DeleteSoundCommand>
{
    public async Task Handle(DeleteSoundCommand cmd, CancellationToken ct)
    {
        MediaAuth.RequireManage(cmd.Permissions);
        if (!await sounds.DeleteAsync(cmd.Id, ct)) throw DomainException.NotFound("sound not found");
    }
}
