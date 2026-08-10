namespace Outcome.Shared.Abstractions.Storage;

/// <summary>Stores uploaded file blobs on disk, keyed by their UUID id.</summary>
public interface IFileStorage
{
    Task SaveAsync(string id, Stream content, CancellationToken ct = default);
    Stream? OpenRead(string id);
    void Delete(string id);
}
