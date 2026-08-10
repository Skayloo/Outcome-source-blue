using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Media;

public sealed class ListSoundsHandler(ISoundRepository sounds) : IRequestHandler<ListSoundsQuery, IReadOnlyList<SoundDto>>
{
    public async Task<IReadOnlyList<SoundDto>> Handle(ListSoundsQuery q, CancellationToken ct)
    {
        var rows = await sounds.ListAsync(ct);
        return rows.Select(s => new SoundDto(s.Id, s.Name, s.Filename, s.DurationMs, s.UploadedBy, s.CreatedAt)).ToList();
    }
}
