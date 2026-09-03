using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Application.Admin;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Api.Endpoints;

public static class SetupEndpoints
{
    public sealed record SetupBody(string Email, string Username, string Password);

    /// <summary>Serialises setup within this process, so the handler's "is there a user yet?"
    /// check and the insert that follows it cannot interleave with another attempt.</summary>
    private static readonly SemaphoreSlim SetupGate = new(1, 1);

    public static void MapSetupEndpoints(this IEndpointRouteBuilder app)
    {

        app.MapGet("/api/v1/setup/status", async (ISender mediator) => await mediator.Send(new SetupStatusQuery()));

        // The one unauthenticated endpoint that CREATES the owner. The handler refuses once any
        // user exists, but that is a read followed by a write: two requests arriving together on
        // an empty database could both pass it. One at a time, and not many.
        app.MapPost("/api/v1/setup", async (SetupBody body, HttpContext ctx, ISender mediator, IRateLimiter limiter) =>
        {
            if (!limiter.Allow("setup", 5, TimeSpan.FromMinutes(1)))
                throw new Outcome.Domain.Errors.DomainException("RATE_LIMITED", 429, "too many attempts");
            await SetupGate.WaitAsync(ctx.RequestAborted);
            try
            {
                return await mediator.Send(new SetupCommand(
                    body.Email, body.Username, body.Password, ctx.Request.Headers.UserAgent.ToString(),
                    ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown"));
            }
            finally { SetupGate.Release(); }
        });
    }
}
