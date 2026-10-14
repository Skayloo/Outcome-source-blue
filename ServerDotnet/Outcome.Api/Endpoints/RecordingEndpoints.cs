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

    /// <summary>Parts live under the uploader's space and id, so nobody can append to or finish
    /// another person's upload (user ids repeat across spaces, which share one bucket), and an
    /// upload id alone is useless to anyone else. The prefix is what the bucket expires them by.</summary>
    private static string PartKey(long spaceId, long userId, Guid upload, int index) =>
        $"{Outcome.Infrastructure.Storage.StorageLifecycle.RecordingPartPrefix}s{spaceId}-{userId}-{upload:N}-{index:D4}";

    // About 12 GB of parts a day per account: a long meeting is well under a tenth of it.
    private const int MaxPartsPerDay = 400;

    public static void MapRecordingEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPut("/api/v1/recordings/{upload:guid}/parts/{index:int}", async (Guid upload, int index, HttpContext ctx,
            ICurrentUser current, IFileStorage storage, IRateLimiter limiter, Outcome.Infrastructure.Tenancy.ICurrentSpace space) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (index < 0 || index >= MaxParts) throw DomainException.BadRequest("part index out of range");
            // Any account could fill the bucket every space shares; parts are now limited per day.
            if (!limiter.Allow($"rec-parts:{space.Space.Id}:{current.UserId}", MaxPartsPerDay, TimeSpan.FromDays(1)))
                throw DomainException.RateLimited("too much recording uploaded today");
            var size = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (size is { IsReadOnly: false }) size.MaxRequestBodySize = MaxPartBytes;
            if (ctx.Request.ContentLength is > MaxPartBytes) throw DomainException.BadRequest("part too large");
            await storage.SaveAsync(PartKey(space.Space.Id, current.UserId, upload, index), ctx.Request.Body, ctx.RequestAborted);
            return Results.NoContent();
        });

        app.MapPost("/api/v1/recordings/{upload:guid}/complete", async (Guid upload, CompleteBody body, HttpContext ctx,
            ICurrentUser current, IFileStorage storage, ISender mediator, IFileUrlSigner fileUrls,
            Outcome.Infrastructure.Media.RecordingRemuxer remuxer, Outcome.Infrastructure.Tenancy.ICurrentSpace space) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (body.Parts is < 1 or > MaxParts) throw DomainException.BadRequest("bad part count");
            var mime = (body.Mime ?? "").Split(';')[0].Trim().ToLowerInvariant();
            if (!Types.Contains(mime)) throw DomainException.BadRequest("a recording is WebM or MP4");

            var keys = Enumerable.Range(0, body.Parts).Select(i => PartKey(space.Space.Id, current.UserId, upload, i)).ToList();
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
            // parts cannot say until they have all been read — and ffmpeg needs a file to remux.
            long size;
            var joinedPath = Path.GetTempFileName();
            string? remuxed = null;
            try
            {
                await using (var joined = new ConcatStream(storage, keys))
                await using (var temp = new FileStream(joinedPath, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, FileOptions.Asynchronous))
                    await joined.CopyToAsync(temp, ctx.RequestAborted);
                // As recorded the file is fragmented with no duration; Firefox and the iPhone then
                // run the slider out before the video ends. See RecordingRemuxer.
                remuxed = await remuxer.RemuxAsync(joinedPath, mime, ctx.RequestAborted);
                await using var stored = new FileStream(remuxed ?? joinedPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, FileOptions.Asynchronous);
                size = stored.Length;
                await storage.SaveAsync(id, stored, ctx.RequestAborted);
            }
            finally
            {
                File.Delete(joinedPath);
                if (remuxed is not null) File.Delete(remuxed);
            }
            foreach (var k in keys) storage.Delete(k);

            var name = string.IsNullOrWhiteSpace(body.Filename) ? $"recording.{mime.Split('/')[1]}" : Path.GetFileName(body.Filename.Trim());
            if (name.Length > 120) name = name[^120..];
            try
            {
                await mediator.Send(new CreateAttachmentCommand(id, name, id, mime, size, null, null), ctx.RequestAborted);
            }
            catch
            {
                storage.Delete(id);
                throw;
            }
            return Results.Json(new { id, filename = name, size, mime, url = fileUrls.Sign(id) });
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
