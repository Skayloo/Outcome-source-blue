using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed class ListSessionsHandler(ISessionRepository sessions, ICurrentUser current)
    : IRequestHandler<ListSessionsQuery, IReadOnlyList<SessionDto>>
{
    public async Task<IReadOnlyList<SessionDto>> Handle(ListSessionsQuery q, CancellationToken ct)
    {
        var rows = await sessions.ListForUserAsync(q.UserId, ct);
        return rows.Select(s => new SessionDto(
            s.Id, s.Device, s.IpAddress, s.CreatedAt, s.LastUsed, s.ExpiresAt,
            Current: s.Token == current.SessionTokenHash)).ToList();
    }
}
