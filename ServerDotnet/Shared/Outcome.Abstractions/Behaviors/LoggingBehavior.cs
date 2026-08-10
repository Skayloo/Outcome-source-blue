using System.Diagnostics;
using MediatR;
using Microsoft.Extensions.Logging;

namespace Outcome.Shared.Abstractions.Behaviors;

/// <summary>Structured timing/logging around each request handler.</summary>
public sealed class LoggingBehavior<TRequest, TResponse>(ILogger<LoggingBehavior<TRequest, TResponse>> logger)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
    {
        var name = typeof(TRequest).Name;
        logger.LogDebug("Handling {Request}", name);
        var sw = Stopwatch.StartNew();
        var response = await next();
        sw.Stop();
        logger.LogDebug("Handled {Request} in {ElapsedMs}ms", name, sw.ElapsedMilliseconds);
        return response;
    }
}
