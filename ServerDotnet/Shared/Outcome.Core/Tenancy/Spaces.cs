using System.Collections.Concurrent;
using Npgsql;

namespace Outcome.Infrastructure.Tenancy;

public interface ISpaceRegistry
{
    Task<IReadOnlyList<Space>> ListAsync(CancellationToken ct = default);
    Task<Space> RootAsync(CancellationToken ct = default);
    Task<Space?> ByIdAsync(long id, CancellationToken ct = default);
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
            // The sequence only ever moves FORWARD (past the explicit id 1 above): setting it to
            // max(id) rewound it after the newest space was deleted, and the next space got the
            // dead one's id — and with it the Redis replay buffer and LiveKit rooms keyed by it.
            cmd.CommandText = """
                INSERT INTO spaces (id, slug, name, domain, db_name)
                VALUES (1, 'root', 'Outcome', NULL, @db)
                ON CONFLICT (id) DO NOTHING;
                SELECT setval(q.seq, GREATEST((SELECT max(id) FROM spaces), 1, nextval(q.seq) - 1))
                FROM (SELECT pg_get_serial_sequence('spaces','id') AS seq) q;
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
        // One space in this edition. A database brought over from an instance that had others
        // keeps their rows; they are simply never served or migrated here.
        cmd.CommandText = $"SELECT {Columns} FROM spaces WHERE id = 1";
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add(Read(r));

        _cache[0] = (DateTime.UtcNow, list);
        return list;
    }

    public async Task<Space> RootAsync(CancellationToken ct = default) =>
        (await ListAsync(ct)).FirstOrDefault(s => s.IsRoot)
        ?? new Space(Space.RootId, "root", "Outcome", null, _rootDb, true);

    public async Task<Space?> ByIdAsync(long id, CancellationToken ct = default) =>
        (await ListAsync(ct)).FirstOrDefault(s => s.Id == id);

    public string ConnectionFor(Space space) => WithDatabase(_pooled, space.DbName);
    public string DirectConnectionFor(Space space) => WithDatabase(_direct, space.DbName);

    private const string Columns = "id, slug, name, domain, db_name, active";

    private static Space Read(NpgsqlDataReader r) => new(r.GetInt64(0), r.GetString(1), r.GetString(2),
        r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4), r.GetBoolean(5));

    private static string WithDatabase(string cs, string db) =>
        new NpgsqlConnectionStringBuilder(cs) { Database = db }.ConnectionString;
}
