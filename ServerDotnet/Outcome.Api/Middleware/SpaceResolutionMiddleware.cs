using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Middleware;

/// <summary>
/// Pins the instance's space to the scope, so every DbContext built downstream opens its
/// database. Must run before anything that touches data — including authentication. There is
/// one space, whatever the request's host.
/// </summary>
public sealed class SpaceResolutionMiddleware(RequestDelegate next, ISpaceRegistry registry)
{
    public async Task Invoke(HttpContext ctx, ICurrentSpace current)
    {
        var space = await registry.RootAsync(ctx.RequestAborted);
        current.Set(space);
        // Handy in logs.
        ctx.Response.Headers["X-Space"] = space.Slug;
        await next(ctx);
    }
}
