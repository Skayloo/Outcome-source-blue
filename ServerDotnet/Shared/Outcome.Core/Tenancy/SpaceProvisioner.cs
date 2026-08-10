using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;
using Outcome.Infrastructure.Persistence;

namespace Outcome.Infrastructure.Tenancy;

/// <summary>
/// Brings a space's database into existence and up to schema. Creating the row in
/// <c>spaces</c> is not enough — the tenant needs its own database with the full schema
/// (the InitialCreate migration also seeds roles and settings, so a fresh space is usable
/// the moment this returns).
/// </summary>
public sealed class SpaceProvisioner(ISpaceRegistry registry, ILogger<SpaceProvisioner> logger)
{
    /// <summary>CREATE DATABASE (if absent) + migrate. Safe to re-run on an existing space.</summary>
    public async Task ProvisionAsync(Space space, CancellationToken ct = default)
    {
        await CreateDatabaseAsync(space, ct);
        Migrate(space);
        await NameItselfAsync(space, ct);
    }

    /// <summary>
    /// The schema seeds server_name with the product default ("Outcome Server"), which is
    /// what the tenant's login screen would then show. A space is named after itself until
    /// someone deliberately renames it.
    /// </summary>
    private async Task NameItselfAsync(Space space, CancellationToken ct)
    {
        if (space.IsRoot) return;
        await using var conn = new NpgsqlConnection(registry.DirectConnectionFor(space));
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE settings SET value = @name
             WHERE key = 'server_name' AND (value = '' OR value = 'Outcome Server')
            """;
        cmd.Parameters.AddWithValue("name", space.Name);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task CreateDatabaseAsync(Space space, CancellationToken ct)
    {
        // CREATE DATABASE cannot run inside a transaction, so it must not go through
        // pgbouncer in transaction pooling mode — connect to the maintenance database
        // directly instead.
        var admin = new NpgsqlConnectionStringBuilder(registry.DirectConnectionFor(space)) { Database = "postgres" };
        await using var conn = new NpgsqlConnection(admin.ConnectionString);
        await conn.OpenAsync(ct);

        await using (var exists = conn.CreateCommand())
        {
            exists.CommandText = "SELECT 1 FROM pg_database WHERE datname = @db";
            exists.Parameters.AddWithValue("db", space.DbName);
            if (await exists.ExecuteScalarAsync(ct) is not null)
            {
                logger.LogInformation("Space {Slug}: database {Db} already exists", space.Slug, space.DbName);
                return;
            }
        }

        await using var create = conn.CreateCommand();
        // The name is ours (outcome_<slug>, slug validated at the API edge) and CREATE DATABASE
        // takes no parameters — quote it as an identifier rather than interpolating raw.
        create.CommandText = $"CREATE DATABASE \"{space.DbName.Replace("\"", "\"\"")}\"";
        await create.ExecuteNonQueryAsync(ct);
        logger.LogInformation("Space {Slug}: created database {Db}", space.Slug, space.DbName);
    }

    private const long MigrationLockId = 0x0C0FFEE0L;

    private void Migrate(Space space)
    {
        // Serialized behind a per-database advisory lock so replicas starting together can't
        // race the migrator. Pooling=false, or Close() would park the session (and the lock)
        // in the pool and hang every other replica.
        var lockCsb = new NpgsqlConnectionStringBuilder(registry.DirectConnectionFor(space)) { Pooling = false };
        using var lockConn = new NpgsqlConnection(lockCsb.ConnectionString);
        lockConn.Open();
        using (var cmd = new NpgsqlCommand($"SELECT pg_advisory_lock({MigrationLockId})", lockConn))
        {
            cmd.CommandTimeout = 300;
            cmd.ExecuteNonQuery();
        }

        try
        {
            MigrateLocked(space);
        }
        finally
        {
            lockConn.Close();
        }
    }

    private void MigrateLocked(Space space)
    {
        var options = new DbContextOptionsBuilder<OutcomeDbContext>()
            .UseNpgsql(registry.DirectConnectionFor(space),
                npg => npg.MigrationsAssembly(typeof(OutcomeDbContext).Assembly.GetName().Name))
            .Options;
        using var db = new OutcomeDbContext(options);
        db.Database.Migrate();
        logger.LogInformation("Space {Slug}: schema up to date", space.Slug);
    }

    /// <summary>Every active space, at startup — a new deploy must not leave a tenant behind.</summary>
    public async Task ProvisionAllAsync(CancellationToken ct = default)
    {
        foreach (var space in await registry.ListAsync(ct))
        {
            if (!space.Active) continue;
            try
            {
                await ProvisionAsync(space, ct);
            }
            catch (Exception ex)
            {
                // One broken tenant must not stop the instance from serving the others.
                logger.LogError(ex, "Space {Slug}: provisioning failed", space.Slug);
            }
        }
    }
}
