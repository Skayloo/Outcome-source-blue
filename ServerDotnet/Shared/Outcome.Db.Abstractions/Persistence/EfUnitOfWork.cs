using Microsoft.EntityFrameworkCore.Storage;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Infrastructure.Persistence;

/// <summary>Unit of Work backed by the EF Core DbContext transaction.</summary>
public sealed class EfUnitOfWork(OutcomeDbContext db) : IUnitOfWork
{
    private IDbContextTransaction? _transaction;

    public async Task BeginAsync(CancellationToken ct = default)
    {
        _transaction ??= await db.Database.BeginTransactionAsync(ct);
    }

    public async Task CommitAsync(CancellationToken ct = default)
    {
        await db.SaveChangesAsync(ct);
        if (_transaction is not null)
        {
            await _transaction.CommitAsync(ct);
            await _transaction.DisposeAsync();
            _transaction = null;
        }
    }

    public async Task RollbackAsync(CancellationToken ct = default)
    {
        if (_transaction is not null)
        {
            await _transaction.RollbackAsync(ct);
            await _transaction.DisposeAsync();
            _transaction = null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_transaction is not null) await _transaction.DisposeAsync();
    }
}
