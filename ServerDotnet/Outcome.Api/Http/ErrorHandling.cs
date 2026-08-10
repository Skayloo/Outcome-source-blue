using Newtonsoft.Json;
using Outcome.Domain.Errors;

namespace Outcome.Api.Http;

/// <summary>The standard error wire shape: <c>{ "error": code, "message": text }</c>.</summary>
public sealed record ErrorEnvelope(
    [property: JsonProperty("error")] string Error,
    [property: JsonProperty("message")] string Message);

/// <summary>Maps <see cref="DomainException"/> to the error envelope; everything else to 500.</summary>
public sealed class ErrorHandlingMiddleware(RequestDelegate next, ILogger<ErrorHandlingMiddleware> logger)
{
    public async Task Invoke(HttpContext ctx)
    {
        try
        {
            await next(ctx);
        }
        catch (DomainException ex)
        {
            await WriteAsync(ctx, ex.StatusCode, ex.Code, ex.Message);
        }
        catch (BadHttpRequestException ex)
        {
            // Kestrel rejects an oversized/malformed body (e.g. an upload past MaxRequestBodySize)
            // by throwing this — surface its real status (413/400) instead of a generic 500.
            var msg = ex.StatusCode == StatusCodes.Status413PayloadTooLarge ? "request body too large" : "bad request";
            await WriteAsync(ctx, ex.StatusCode, "BAD_REQUEST", msg);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Unhandled exception processing {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            await WriteAsync(ctx, StatusCodes.Status500InternalServerError, "SERVER_ERROR", "internal server error");
        }
    }

    private static async Task WriteAsync(HttpContext ctx, int status, string code, string message)
    {
        if (ctx.Response.HasStarted) return;
        ctx.Response.Clear();
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        await ctx.Response.WriteAsync(OutcomeJson.Serialize(new ErrorEnvelope(code, message)));
    }
}
