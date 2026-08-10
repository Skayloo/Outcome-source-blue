using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Middleware;

/// <summary>
/// Resolves the SPACE (tenant) from the request's Host and pins it to the scope, so every
/// DbContext built downstream opens that space's database. Must run before anything that
/// touches data — including authentication, since a token is only valid inside the space
/// that issued it.
/// </summary>
public sealed class SpaceResolutionMiddleware(RequestDelegate next, ISpaceRegistry registry)
{
    public async Task Invoke(HttpContext ctx, ICurrentSpace current)
    {
        var space = await registry.ForHostAsync(ctx.Request.Host.Host, ctx.RequestAborted);
        current.Set(space);
        // Handy in logs and for the client to know which space answered.
        ctx.Response.Headers["X-Space"] = space.Slug;
        await next(ctx);
    }
}
