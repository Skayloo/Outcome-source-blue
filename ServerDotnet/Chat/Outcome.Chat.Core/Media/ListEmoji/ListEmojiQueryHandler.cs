using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Media;

public sealed class ListEmojiHandler(IEmojiRepository emoji) : IRequestHandler<ListEmojiQuery, IReadOnlyList<EmojiDto>>
{
    public async Task<IReadOnlyList<EmojiDto>> Handle(ListEmojiQuery q, CancellationToken ct)
    {
        var rows = await emoji.ListAsync(ct);
        return rows.Select(e => new EmojiDto(e.Id, e.Shortcode, e.Filename, e.UploadedBy, e.CreatedAt)).ToList();
    }
}
