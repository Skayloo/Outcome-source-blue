using MediatR;
using Microsoft.AspNetCore.Http.Features;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Application.Uploads;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

/// <summary>
/// Uploading a call recording into the room's chat (W3GWG-25 stage 4). A recording is made on
/// the recorder's computer and runs to hundreds of megabytes, past what one request may carry
/// through the proxies (110 MB at the edge, 100 MB in nginx). So it comes in parts, each stored
/// as an object of its own — any replica can take any part — and is joined into one file on
/// completion, stream to stream, never whole in memory. The result is an ordinary attachment the
/// client then posts in the room's chat.
/// </summary>
public static class RecordingEndpoints
{
    private const long MaxPartBytes = 32L * 1024 * 1024;
    private const int MaxParts = 256; // 8 GB
    private static readonly HashSet<string> Types = ["video/webm", "audio/webm", "video/mp4", "audio/mp4"];

    public sealed record CompleteBody(int Parts, string? Filename, string? Mime);

    /// <summary>Parts live under the uploader's id, so nobody can append to or finish another
    /// person's upload, and an upload id alone is useless to anyone else.</summary>
    private static string PartKey(long userId, Guid upload, int index) => $"rec-{userId}-{upload:N}-{index:D4}";

    public static void MapRecordingEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPut("/api/v1/recordings/{upload:guid}/parts/{index:int}", async (Guid upload, int index, HttpContext ctx,
            ICurrentUser current, IFileStorage storage) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (index < 0 || index >= MaxParts) throw DomainException.BadRequest("part index out of range");
            var size = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (size is { IsReadOnly: false }) size.MaxRequestBodySize = MaxPartBytes;
            if (ctx.Request.ContentLength is > MaxPartBytes) throw DomainException.BadRequest("part too large");
            await storage.SaveAsync(PartKey(current.UserId, upload, index), ctx.Request.Body, ctx.RequestAborted);
            return Results.NoContent();
        });

        app.MapPost("/api/v1/recordings/{upload:guid}/complete", async (Guid upload, CompleteBody body, HttpContext ctx,
            ICurrentUser current, IFileStorage storage, ISender mediator, IFileUrlSigner fileUrls) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (body.Parts is < 1 or > MaxParts) throw DomainException.BadRequest("bad part count");
            var mime = (body.Mime ?? "").Split(';')[0].Trim().ToLowerInvariant();
            if (!Types.Contains(mime)) throw DomainException.BadRequest("a recording is WebM or MP4");

            var keys = Enumerable.Range(0, body.Parts).Select(i => PartKey(current.UserId, upload, i)).ToList();
            // By content, not the label: WebM starts with the EBML magic, MP4 with an ftyp box.
            await using (var first = storage.OpenRead(keys[0]) ?? throw DomainException.BadRequest("part 0 is missing"))
            {
                var head = new byte[12];
                var n = await first.ReadAsync(head.AsMemory(0, 12), ctx.RequestAborted);
                var webm = n >= 4 && head[0] == 0x1A && head[1] == 0x45 && head[2] == 0xDF && head[3] == 0xA3;
                var mp4 = n >= 8 && head[4] == (byte)'f' && head[5] == (byte)'t' && head[6] == (byte)'y' && head[7] == (byte)'p';
                if (!(webm && mime.EndsWith("/webm", StringComparison.Ordinal)) && !(mp4 && mime.EndsWith("/mp4", StringComparison.Ordinal)))
                    throw DomainException.BadRequest("the file is not the recording it says it is");
            }

            var id = Guid.NewGuid().ToString();
            // Through a temp file: storage wants to know how long an object is, which the joined
            // parts cannot say until they have all been read.
            await using var joined = new ConcatStream(storage, keys);
            await using (var temp = new FileStream(Path.GetTempFileName(), FileMode.Create, FileAccess.ReadWrite,
                FileShare.None, 1 << 16, FileOptions.DeleteOnClose | FileOptions.Asynchronous))
            {
                await joined.CopyToAsync(temp, ctx.RequestAborted);
                temp.Position = 0;
                await storage.SaveAsync(id, temp, ctx.RequestAborted);
            }
            foreach (var k in keys) storage.Delete(k);

            var name = string.IsNullOrWhiteSpace(body.Filename) ? $"recording.{mime.Split('/')[1]}" : Path.GetFileName(body.Filename.Trim());
            if (name.Length > 120) name = name[^120..];
            try
            {
                await mediator.Send(new CreateAttachmentCommand(id, name, id, mime, joined.Total, null, null), ctx.RequestAborted);
            }
            catch
            {
                storage.Delete(id);
                throw;
            }
            return Results.Json(new { id, filename = name, size = joined.Total, mime, url = fileUrls.Sign(id) });
        });
    }

    /// <summary>The parts, read one after another as a single stream.</summary>
    private sealed class ConcatStream(IFileStorage storage, IReadOnlyList<string> keys) : Stream
    {
        private int _next;
        private Stream? _current;
        public long Total { get; private set; }

        public override int Read(byte[] buffer, int offset, int count) =>
            ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            while (true)
            {
                if (_current is null)
                {
                    if (_next >= keys.Count) return 0;
                    _current = storage.OpenRead(keys[_next]) ?? throw DomainException.BadRequest($"part {_next} is missing");
                    _next++;
                }
                var n = await _current.ReadAsync(buffer, ct);
                if (n > 0) { Total += n; return n; }
                await _current.DisposeAsync();
                _current = null;
            }
        }

        public override async ValueTask DisposeAsync()
        {
            if (_current is not null) await _current.DisposeAsync();
            await base.DisposeAsync();
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => Total; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
