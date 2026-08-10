using Outcome.Api.Http;

namespace Outcome.Api.Middleware;

/// <summary>
/// Global endpoint filter that serializes endpoint return values with Newtonsoft.Json instead of
/// the minimal-API default (System.Text.Json). Values that are already an <see cref="IResult"/>
/// (Results.NotFound, NoContent, Stream, the error envelope, ...) pass through unchanged.
/// </summary>
public sealed class NewtonsoftJsonOutputFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var result = await next(ctx);
        if (result is null || result is IResult) return result;
        return Results.Text(OutcomeJson.Serialize(result), "application/json; charset=utf-8");
    }
}
