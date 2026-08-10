using MediatR;
using Outcome.Api.Realtime;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Friends;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class FriendEndpoints
{
    public sealed record AddFriendBody(long UserId);

    public static void MapFriendEndpoints(this IEndpointRouteBuilder app)
    {
        // Accepted friends + pending requests in both directions.
        app.MapGet("/api/v1/friends", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new GetFriendsQuery(current.UserId));
        });

        // Send (or auto-accept a reciprocal) friend request; notify the target over WS.
        app.MapPost("/api/v1/friends", async (
            AddFriendBody body, ICurrentUser current, ISender mediator, IConnectionRegistry registry, IUserRepository users) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var result = await mediator.Send(new SendFriendRequestCommand(current.UserId, body.UserId));

            if (result.AutoAccepted)
            {
                // The target had already requested us: both sides are now friends.
                var me = await users.GetByIdAsync(current.UserId);
                var target = await users.GetByIdAsync(body.UserId);
                if (me is not null)
                    await registry.SendToUserAsync(body.UserId, WsFrames.FriendAccepted(me.Id, me.Username, me.Avatar, me.Status));
                if (target is not null)
                    await registry.SendToUserAsync(current.UserId, WsFrames.FriendAccepted(target.Id, target.Username, target.Avatar, target.Status));
            }
            else if (result.Created)
            {
                var me = await users.GetByIdAsync(current.UserId);
                if (me is not null)
                    await registry.SendToUserAsync(body.UserId, WsFrames.FriendRequest(me.Id, me.Username, me.Avatar, me.Status));
            }
            return Results.NoContent();
        });

        // Accept an incoming request; notify the original requester.
        app.MapPost("/api/v1/friends/{userId:long}/accept", async (
            long userId, ICurrentUser current, ISender mediator, IConnectionRegistry registry, IUserRepository users) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var accepted = await mediator.Send(new AcceptFriendCommand(current.UserId, userId));
            if (accepted)
            {
                var me = await users.GetByIdAsync(current.UserId);
                if (me is not null)
                    await registry.SendToUserAsync(userId, WsFrames.FriendAccepted(me.Id, me.Username, me.Avatar, me.Status));
            }
            return Results.NoContent();
        });

        // Remove a friend / cancel or decline a request; notify the other user.
        app.MapDelete("/api/v1/friends/{userId:long}", async (
            long userId, ICurrentUser current, ISender mediator, IConnectionRegistry registry) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var removed = await mediator.Send(new RemoveFriendCommand(current.UserId, userId));
            if (removed)
                await registry.SendToUserAsync(userId, WsFrames.FriendRemoved(current.UserId));
            return Results.NoContent();
        });
    }
}
