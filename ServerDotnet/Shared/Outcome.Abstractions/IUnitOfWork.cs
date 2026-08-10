namespace Outcome.Shared.Abstractions.Persistence;

/// <summary>
/// Transactional boundary for a command, backed by the EF Core DbContext.
/// The MediatR <c>TransactionBehavior</c> opens a transaction before a command and
/// commits (SaveChanges + Commit) after it, or rolls back on failure.
/// </summary>
public interface IUnitOfWork : IAsyncDisposable
{
    Task BeginAsync(CancellationToken ct = default);
    Task CommitAsync(CancellationToken ct = default);
    Task RollbackAsync(CancellationToken ct = default);
}
