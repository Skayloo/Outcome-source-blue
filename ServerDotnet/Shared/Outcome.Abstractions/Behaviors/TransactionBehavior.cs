using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Shared.Abstractions.Behaviors;

/// <summary>
/// Wraps commands (<see cref="ITransactionalRequest"/>) in a Unit-of-Work transaction:
/// begin → handler → commit, or rollback on any exception. Queries pass straight through.
/// Domain events buffered during the command are published AFTER commit (wired in Phase 8).
/// </summary>
public sealed class TransactionBehavior<TRequest, TResponse>(IUnitOfWork unitOfWork)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
    {
        if (request is not ITransactionalRequest)
            return await next();

        await unitOfWork.BeginAsync(cancellationToken);
        try
        {
            var response = await next();
            await unitOfWork.CommitAsync(cancellationToken);
            return response;
        }
        catch
        {
            await unitOfWork.RollbackAsync(cancellationToken);
            throw;
        }
    }
}
