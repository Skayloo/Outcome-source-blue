namespace Outcome.Shared.Abstractions.Persistence;

public interface ISettingsRepository
{
    Task<string?> GetAsync(string key, CancellationToken ct = default);
    Task<IReadOnlyDictionary<string, string>> GetAllAsync(CancellationToken ct = default);
    Task SetAsync(string key, string value, CancellationToken ct = default);
}

public interface IAuditRepository
{
    Task AddAsync(long actorId, string action, string targetType, long targetId, string detail, CancellationToken ct = default);
}
