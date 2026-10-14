using Minio;
using Minio.DataModel.Args;

namespace Outcome.Infrastructure.Storage;

/// <summary>
/// A stored object read on demand, a block at a time, with ranged GETs. Seekable, with its length
/// known up front — what the files route's range processing (and iOS's progressive playback) need.
///
/// Every download used to copy the WHOLE object into memory first, Range requests included: a
/// recording of a few gigabytes was read in full, on a blocked thread, for each seek in a video
/// player. Now a request costs the blocks it touches. A block covers one encrypted chunk with room
/// to spare (1 MiB of plaintext + nonce + tag), so the decrypting reader above it makes one GET per
/// chunk. Holds no cipher: both storage editions use it.
/// </summary>
public sealed class MinioRangeStream : Stream
{
    private const int Block = (1 << 20) + (128 << 10);

    private readonly IMinioClient _client;
    private readonly string _bucket;
    private readonly string _id;
    private byte[] _buf = [];
    private long _bufStart = -1;
    private long _position;

    public MinioRangeStream(IMinioClient client, string bucket, string id, long length)
    {
        _client = client;
        _bucket = bucket;
        _id = id;
        Length = length;
    }

    /// <summary>The object's first byte, without reading the rest (null for an empty object).</summary>
    public byte? FirstByte()
    {
        if (Length == 0) return null;
        if (!Holds(0)) Fill(0);
        return _buf[0];
    }

    private bool Holds(long at) => _bufStart >= 0 && at >= _bufStart && at < _bufStart + _buf.Length;

    private GetObjectArgs Range(long at, MemoryStream into) => new GetObjectArgs()
        .WithBucket(_bucket).WithObject(_id)
        .WithOffsetAndLength(at, (int)Math.Min(Block, Length - at))
        .WithCallbackStream(s => s.CopyTo(into));

    private void Fill(long at)
    {
        var ms = new MemoryStream();
        _client.GetObjectAsync(Range(at, ms)).GetAwaiter().GetResult();
        Take(at, ms);
    }

    private async Task FillAsync(long at, CancellationToken ct)
    {
        var ms = new MemoryStream();
        await _client.GetObjectAsync(Range(at, ms), ct);
        Take(at, ms);
    }

    private void Take(long at, MemoryStream ms)
    {
        if (ms.Length == 0) throw new IOException($"storage returned nothing for {_id} at {at}");
        _buf = ms.ToArray();
        _bufStart = at;
    }

    private int CopyOut(Span<byte> dest)
    {
        var within = (int)(_position - _bufStart);
        var n = Math.Min(dest.Length, _buf.Length - within);
        _buf.AsSpan(within, n).CopyTo(dest);
        _position += n;
        return n;
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        if (_position >= Length || buffer.Length == 0) return 0;
        if (!Holds(_position)) Fill(_position);
        return CopyOut(buffer);
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        if (_position >= Length || buffer.Length == 0) return 0;
        if (!Holds(_position)) await FillAsync(_position, ct);
        return CopyOut(buffer.Span);
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();

    public override long Seek(long offset, SeekOrigin origin)
    {
        var target = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            _ => Length + offset,
        };
        if (target < 0) throw new IOException("cannot seek before the start of the object");
        _position = target;
        return _position;
    }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length { get; }
    public override long Position { get => _position; set => Seek(value, SeekOrigin.Begin); }
    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
