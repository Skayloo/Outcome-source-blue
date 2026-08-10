using Microsoft.Extensions.Options;
using Minio;
using Minio.DataModel.Args;
using Minio.Exceptions;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Storage;

/// <summary>
/// BLUE edition object storage. Bytes in, the same bytes out.
///
/// This file is the whole of it: no AES, no key, no framing, no version byte, and nothing to
/// configure. That is the point — an edition that "has encryption switched off" is one flag
/// away from having it on, and a stub that mirrors the encrypting API is a slot somebody else
/// can drop their own cipher into. There is no slot here. `System.Security.Cryptography` is
/// not even imported.
///
/// Excluded from the RED build by Outcome.Core.csproj; deploy/export-blue.sh deletes the
/// encrypting MinioFileStorage.cs and renames this file over it, so the exported tree has
/// exactly one implementation and it is this one.
///
/// UPGRADING FROM AN INSTALL THAT STORED FILES ENCRYPTED: decrypt the bucket BEFORE
/// moving to this build — ServerDotnet/tools/DecryptBucket does it in place. Nothing here can
/// read an encrypted object, and it will not pretend to: those files would download as the
/// ciphertext they are.
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
            var ms = new MemoryStream();
            _client.GetObjectAsync(new GetObjectArgs()
                .WithBucket(_bucket)
                .WithObject(id)
                .WithCallbackStream(s => s.CopyTo(ms))).GetAwaiter().GetResult();
            ms.Position = 0;
            return ms;
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
