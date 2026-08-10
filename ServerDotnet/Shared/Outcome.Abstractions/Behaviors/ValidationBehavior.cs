using FluentValidation;
using MediatR;
using Outcome.Domain.Errors;

namespace Outcome.Shared.Abstractions.Behaviors;

/// <summary>Runs all FluentValidation validators for the request before the handler.</summary>
public sealed class ValidationBehavior<TRequest, TResponse>(IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
    {
        if (validators.Any())
        {
            var context = new ValidationContext<TRequest>(request);
            var results = await Task.WhenAll(validators.Select(v => v.ValidateAsync(context, cancellationToken)));
            var failures = results.SelectMany(r => r.Errors).Where(f => f is not null).ToList();
            if (failures.Count != 0)
            {
                var message = string.Join("; ", failures.Select(f => f.ErrorMessage));
                throw DomainException.InvalidInput(message);
            }
        }

        return await next();
    }
}
