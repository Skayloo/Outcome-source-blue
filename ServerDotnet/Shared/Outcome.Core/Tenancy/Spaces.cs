using System.Collections.Concurrent;
using Npgsql;

namespace Outcome.Infrastructure.Tenancy;

public interface ISpaceRegistry
{
    Task<IReadOnlyList<Space>> ListAsync(CancellationToken ct = default);
    Task<Space> RootAsync(CancellationToken ct = default);
    /// <summary>The space serving this host, or the root space when none claims it.</summary>
    Task<Space> ForHostAsync(string? host, CancellationToken ct = default);
    Task<Space?> ByIdAsync(long id, CancellationToken ct = default);
    Task<Space> CreateAsync(string slug, string name, string? domain, CancellationToken ct = default);
    Task<bool> UpdateAsync(long id, string? name, string? domain, bool? active, CancellationToken ct = default);
    Task<bool> DeleteAsync(long id, CancellationToken ct = default);
    /// <summary>Connection string aimed at that space's database.</summary>
    string ConnectionFor(Space space);
    /// <summary>Same, but bypassing pgbouncer — for CREATE DATABASE and migrations.</summary>
    string DirectConnectionFor(Space space);
}

/// <summary>
/// Registry backed by a <c>spaces</c> table in the ROOT database. Deliberately raw SQL and
/// outside the EF model: it is control-plane data about the tenants, so it must not be part
/// of the schema that gets created inside every tenant database.
/// </summary>
public sealed class SpaceRegistry : ISpaceRegistry
{
    private readonly string _pooled;
    private readonly string _direct;
    private readonly string _rootDb;
    // A write on one API instance can't reach another's cache, so entries also age out.
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(10);
    private readonly ConcurrentDictionary<byte, (DateTime At, IReadOnlyList<Space> Spaces)> _cache = new();

    public SpaceRegistry(string pooledConnectionString, string directConnectionString)
    {
        _pooled = pooledConnectionString;
        _direct = directConnectionString;
        _rootDb = new NpgsqlConnectionStringBuilder(pooledConnectionString).Database
                  ?? throw new InvalidOperationException("connection string has no Database");
    }

    /// <summary>Creates the control table and the root row. Idempotent; runs at startup.</summary>
    public async Task EnsureSchemaAsync(CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_direct);
        await conn.OpenAsync(ct);
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                CREATE TABLE IF NOT EXISTS spaces (
                    id       bigserial PRIMARY KEY,
                    slug     text NOT NULL UNIQUE,
                    name     text NOT NULL,
                    domain   text UNIQUE,
                    db_name  text NOT NULL,
                    active   boolean NOT NULL DEFAULT true,
                    created_at timestamptz NOT NULL DEFAULT now()
                );
                """;
            await cmd.ExecuteNonQueryAsync(ct);
        }
        await using (var cmd = conn.CreateCommand())
        {
            // The instance's own space. Its domain stays NULL: it is the fallback for every
            // host no tenant claims, including bare IPs and the apex domain.
            cmd.CommandText = """
                INSERT INTO spaces (id, slug, name, domain, db_name)
                VALUES (1, 'root', 'Outcome', NULL, @db)
                ON CONFLICT (id) DO NOTHING;
                SELECT setval(pg_get_serial_sequence('spaces','id'), GREATEST((SELECT max(id) FROM spaces), 1));
                """;
            cmd.Parameters.AddWithValue("db", _rootDb);
            await cmd.ExecuteNonQueryAsync(ct);
        }
        _cache.Clear();
    }

    public async Task<IReadOnlyList<Space>> ListAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue(0, out var hit) && DateTime.UtcNow - hit.At < CacheTtl) return hit.Spaces;

        var list = new List<Space>();
        await using var conn = new NpgsqlConnection(_pooled);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, slug, name, domain, db_name, active FROM spaces ORDER BY id";
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            list.Add(new Space(r.GetInt64(0), r.GetString(1), r.GetString(2),
                r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4), r.GetBoolean(5)));

        _cache[0] = (DateTime.UtcNow, list);
        return list;
    }

    public async Task<Space> RootAsync(CancellationToken ct = default) =>
        (await ListAsync(ct)).FirstOrDefault(s => s.IsRoot)
        ?? new Space(Space.RootId, "root", "Outcome", null, _rootDb, true);

    public async Task<Space> ForHostAsync(string? host, CancellationToken ct = default)
    {
        var h = host?.Split(':')[0].Trim().TrimEnd('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(h)) return await RootAsync(ct);
        var match = (await ListAsync(ct)).FirstOrDefault(s => s.Active && s.Domain == h);
        return match ?? await RootAsync(ct);
    }

    public async Task<Space?> ByIdAsync(long id, CancellationToken ct = default) =>
        (await ListAsync(ct)).FirstOrDefault(s => s.Id == id);

    public async Task<Space> CreateAsync(string slug, string name, string? domain, CancellationToken ct = default)
    {
        var dbName = DbNameFor(slug);
        await using var conn = new NpgsqlConnection(_pooled);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO spaces (slug, name, domain, db_name)
            VALUES (@slug, @name, @domain, @db)
            RETURNING id, slug, name, domain, db_name, active
            """;
        cmd.Parameters.AddWithValue("slug", slug);
        cmd.Parameters.AddWithValue("name", name);
        cmd.Parameters.AddWithValue("domain", (object?)domain ?? DBNull.Value);
        cmd.Parameters.AddWithValue("db", dbName);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        var space = new Space(r.GetInt64(0), r.GetString(1), r.GetString(2),
            r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4), r.GetBoolean(5));
        _cache.Clear();
        return space;
    }

    public async Task<bool> UpdateAsync(long id, string? name, string? domain, bool? active, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_pooled);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        // COALESCE keeps unspecified fields; domain is cleared with an empty string, since
        // NULL there means "leave it".
        // Explicit casts: a NULL parameter that only ever appears inside COALESCE/CASE gives
        // Postgres nothing to infer a type from ("42P08: could not determine data type").
        cmd.CommandText = """
            UPDATE spaces SET
                name   = COALESCE(@name::text, name),
                domain = CASE WHEN @domain::text IS NULL THEN domain
                              WHEN @domain::text = '' THEN NULL ELSE @domain::text END,
                active = COALESCE(@active::boolean, active)
            WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("id", id);
        cmd.Parameters.AddWithValue("name", (object?)name ?? DBNull.Value);
        cmd.Parameters.AddWithValue("domain", (object?)domain ?? DBNull.Value);
        cmd.Parameters.AddWithValue("active", (object?)active ?? DBNull.Value);
        var n = await cmd.ExecuteNonQueryAsync(ct);
        _cache.Clear();
        return n > 0;
    }

    public async Task<bool> DeleteAsync(long id, CancellationToken ct = default)
    {
        if (id == Space.RootId) throw new InvalidOperationException("the root space cannot be deleted");
        var space = await ByIdAsync(id, ct);
        if (space is null) return false;

        await using (var conn = new NpgsqlConnection(_pooled))
        {
            await conn.OpenAsync(ct);
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM spaces WHERE id = @id";
            cmd.Parameters.AddWithValue("id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }
        _cache.Clear();

        // The database itself is left in place on purpose: dropping a customer's data must be
        // a deliberate act with a backup in hand, not a side effect of removing a row.
        return true;
    }

    public string ConnectionFor(Space space) => WithDatabase(_pooled, space.DbName);
    public string DirectConnectionFor(Space space) => WithDatabase(_direct, space.DbName);

    /// <summary>Postgres identifier for a space's database: <c>outcome_&lt;slug&gt;</c>.</summary>
    public static string DbNameFor(string slug) => "outcome_" + slug;

    private static string WithDatabase(string cs, string db) =>
        new NpgsqlConnectionStringBuilder(cs) { Database = db }.ConnectionString;
}
