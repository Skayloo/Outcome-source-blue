using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Npgsql;
using Outcome.Infrastructure.Persistence;

namespace Outcome.Infrastructure.Migrations;

/// <summary>
/// Applies EF Core migrations at startup, serialized behind a Postgres advisory lock so
/// multiple API replicas starting at once can't race the migrator. The lock connection uses
/// Pooling=false — otherwise Close() would park the physical connection (and the session
/// lock) in the pool and never release it, hanging every other replica.
/// </summary>
public sealed class EfMigrationRunner(
    IServiceScopeFactory scopes, string connectionString, ILogger<EfMigrationRunner> logger)
{
    private const long MigrationLockId = 0x0C0FFEE0L;

    public void Run()
    {
        var csb = new NpgsqlConnectionStringBuilder(connectionString) { Pooling = false };
        using var lockConn = new NpgsqlConnection(csb.ConnectionString);
        lockConn.Open();
        using (var cmd = new NpgsqlCommand($"SELECT pg_advisory_lock({MigrationLockId})", lockConn))
        {
            cmd.CommandTimeout = 300;
            cmd.ExecuteNonQuery();
        }

        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<OutcomeDbContext>();
            db.Database.Migrate();
            logger.LogInformation("EF Core migrations up to date.");
        }
        finally
        {
            lockConn.Close(); // non-pooled → really releases the advisory lock
        }
    }
}
