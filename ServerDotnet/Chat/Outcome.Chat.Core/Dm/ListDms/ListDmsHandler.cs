using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Dm;

public sealed class ListDmsHandler(IDmRepository dms) : IRequestHandler<ListDmsQuery, DmListResponse>
{
    public async Task<DmListResponse> Handle(ListDmsQuery q, CancellationToken ct) =>
        new(await dms.ListForUserAsync(q.UserId, ct));
}
