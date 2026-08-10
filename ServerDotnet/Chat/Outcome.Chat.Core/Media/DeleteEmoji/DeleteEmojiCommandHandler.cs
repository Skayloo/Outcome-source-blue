using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Media;

public sealed class DeleteEmojiHandler(IEmojiRepository emoji) : IRequestHandler<DeleteEmojiCommand>
{
    public async Task Handle(DeleteEmojiCommand cmd, CancellationToken ct)
    {
        MediaAuth.RequireManage(cmd.Permissions);
        if (!await emoji.DeleteAsync(cmd.Id, ct)) throw DomainException.NotFound("emoji not found");
    }
}
