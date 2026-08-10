using MediatR;
using Microsoft.Extensions.Logging;
using Outcome.Domain.Errors;

namespace Outcome.Shared.Abstractions.Behaviors;

/// <summary>Logs unexpected exceptions; lets domain errors propagate untouched for the API to map.</summary>
public sealed class UnhandledExceptionBehavior<TRequest, TResponse>(ILogger<UnhandledExceptionBehavior<TRequest, TResponse>> logger)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
    {
        try
        {
            return await next();
        }
        catch (DomainException)
        {
            throw; // expected business failure — mapped to the error envelope by the API layer
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Unhandled exception while processing {Request}", typeof(TRequest).Name);
            throw;
        }
    }
}
