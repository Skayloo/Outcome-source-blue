using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Channels;

public sealed class ListChannelsHandler(
    ICurrentUser current,
    ICurrentServer server,
    IChannelRepository channels,
    IChannelOverrideRepository overrides) : IRequestHandler<ListChannelsQuery, IReadOnlyList<ChannelDto>>
{
    public async Task<IReadOnlyList<ChannelDto>> Handle(ListChannelsQuery request, CancellationToken ct)
    {
        if (!current.IsAuthenticated)
            throw DomainException.Unauthorized("not authenticated");

        var all = await channels.ListAsync(server.ServerId, ct);
        var baseNames = current.PermissionNames;
        var isAdmin = baseNames.Contains(Perms.Administrator);
        var ovr = isAdmin ? null : await overrides.GetForRoleAsync(current.RoleId, ct);

        var visible = new List<ChannelDto>(all.Count);
        foreach (var ch in all)
        {
            if (isAdmin)
            {
                visible.Add(ChannelMapper.ToDto(ch));
                continue;
            }
            ovr!.TryGetValue(ch.Id, out var o);
            if (Perms.ApplyOverride(baseNames, o.Allow, o.Deny).Contains(Perms.ReadMessages))
                visible.Add(ChannelMapper.ToDto(ch));
        }
        return visible;
    }
}
