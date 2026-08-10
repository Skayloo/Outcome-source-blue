using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Storage;

/// <summary>Disk-backed file storage. Files are named by their UUID id under the configured dir.</summary>
public sealed class FileStorage : IFileStorage
{
    private readonly string _dir;

    public FileStorage(IOptions<UploadOptions> options)
    {
        _dir = options.Value.StorageDir;
        Directory.CreateDirectory(_dir);
    }

    public async Task SaveAsync(string id, Stream content, CancellationToken ct = default)
    {
        await using var fs = File.Create(PathFor(id));
        await content.CopyToAsync(fs, ct);
    }

    public Stream? OpenRead(string id)
    {
        var path = PathFor(id);
        return File.Exists(path) ? File.OpenRead(path) : null;
    }

    public void Delete(string id)
    {
        var path = PathFor(id);
        if (File.Exists(path)) File.Delete(path);
    }

    // Path.GetFileName strips any directory components — a guard against path traversal.
    private string PathFor(string id) => Path.Combine(_dir, Path.GetFileName(id));
}
