using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Application.Admin;

namespace Outcome.Api.Endpoints;

public static class SetupEndpoints
{
    public sealed record SetupBody(string Email, string Username, string Password);

    public static void MapSetupEndpoints(this IEndpointRouteBuilder app)
    {

        app.MapGet("/api/v1/setup/status", async (ISender mediator) => await mediator.Send(new SetupStatusQuery()));

        app.MapPost("/api/v1/setup", async (SetupBody body, HttpContext ctx, ISender mediator) =>
        {
            var result = await mediator.Send(new SetupCommand(
                body.Email, body.Username, body.Password, ctx.Request.Headers.UserAgent.ToString(),
                ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown"));
            return result;
        });
    }
}
