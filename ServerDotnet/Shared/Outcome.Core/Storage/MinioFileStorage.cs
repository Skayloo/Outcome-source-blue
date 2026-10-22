using Microsoft.Extensions.Options;
using Minio;
using Minio.DataModel.Args;
using Minio.Exceptions;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Storage;

/// <summary>
/// Object storage for uploads, on MinIO (or any S3). Bytes in, the same bytes out.
/// </summary>
public sealed class MinioFileStorage : IFileStorage
{
    private readonly IMinioClient _client;
    private readonly string _bucket;
    private readonly SemaphoreSlim _bucketGate = new(1, 1);
    private volatile bool _bucketReady;

    public MinioFileStorage(IOptions<MinioOptions> options)
    {
        var o = options.Value;
        _bucket = o.Bucket;
        _client = new MinioClient()
            .WithEndpoint(o.Endpoint)
            .WithCredentials(o.AccessKey, o.SecretKey)
            .WithSSL(o.UseSsl)
            .Build();
    }

    private async Task EnsureBucketAsync(CancellationToken ct)
    {
        if (_bucketReady) return;
        await _bucketGate.WaitAsync(ct);
        try
        {
            if (_bucketReady) return;
            var exists = await _client.BucketExistsAsync(new BucketExistsArgs().WithBucket(_bucket), ct);
            if (!exists)
                await _client.MakeBucketAsync(new MakeBucketArgs().WithBucket(_bucket), ct);
            // Unfinished recording uploads expire (StorageLifecycle). A backend without lifecycle
            // support must not stop the bucket from working.
            try { await StorageLifecycle.ExpireRecordingPartsAsync(_client, _bucket, ct); }
            catch (Exception ex) { Console.Error.WriteLine($"storage: recording-part expiry not set: {ex.Message}"); }
            _bucketReady = true;
        }
        finally
        {
            _bucketGate.Release();
        }
    }

    public async Task SaveAsync(string id, Stream content, CancellationToken ct = default)
    {
        await EnsureBucketAsync(ct);
        await _client.PutObjectAsync(new PutObjectArgs()
            .WithBucket(_bucket)
            .WithObject(id)
            .WithStreamData(content)
            .WithObjectSize(content.CanSeek ? content.Length - content.Position : -1)
            .WithContentType("application/octet-stream"), ct);
    }

    /// <summary>
    /// The object, seekable. Range processing needs a length up front and the ability to jump,
    /// and iOS will not play progressive audio from a response with no Content-Length — a
    /// sequential-only stream turns every voice message into a file that downloads but never
    /// plays.
    /// </summary>
    public Stream? OpenRead(string id)
    {
        try
        {
            EnsureBucketAsync(CancellationToken.None).GetAwaiter().GetResult();
            var stat = _client.StatObjectAsync(new StatObjectArgs().WithBucket(_bucket).WithObject(id)).GetAwaiter().GetResult();
            // Read on demand, a block per ranged GET (MinioRangeStream): copying every object
            // whole into memory first cost a full read per Range request of a video.
            return new MinioRangeStream(_client, _bucket, id, stat.Size);
        }
        catch (ObjectNotFoundException)
        {
            return null;
        }
        catch (MinioException)
        {
            return null;
        }
    }

    public void Delete(string id)
    {
        try
        {
            _client.RemoveObjectAsync(new RemoveObjectArgs()
                .WithBucket(_bucket)
                .WithObject(id)).GetAwaiter().GetResult();
        }
        catch (MinioException)
        {
            // already gone / bucket missing — nothing to do
        }
    }
}
