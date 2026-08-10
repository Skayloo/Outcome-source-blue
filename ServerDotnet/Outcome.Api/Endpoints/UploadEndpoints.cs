using MediatR;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Application.Uploads;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class UploadEndpoints
{
    /// <summary>Hard ceiling on any uploaded file (avatars, attachments, bug screenshots) — 10 MB.
    /// Enforced at three layers: nginx client_max_body_size, the Kestrel per-request body cap
    /// below, and the explicit length check — so a malicious oversized upload can't exhaust
    /// memory/disk.</summary>
    private const long MaxUploadBytes = 100L * 1024 * 1024;

    public static void MapUploadEndpoints(this IEndpointRouteBuilder app)
    {

        // POST /api/v1/uploads — multipart "file" field, auth required. Read the form manually
        // (instead of an IFormFile parameter) so the body-size cap is applied BEFORE the body is
        // buffered — parameter binding would read the form too early to limit it.
        app.MapPost("/api/v1/uploads",
            async (HttpContext ctx, ICurrentUser current, IFileStorage storage, ISender mediator) =>
            {
                if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");

                // Cap the request body before reading it — Kestrel aborts the connection with 413
                // if the client streams more than this, regardless of a lying Content-Length.
                var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
                if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxUploadBytes;

                if (!ctx.Request.HasFormContentType) throw DomainException.BadRequest("expected a multipart form");
                var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
                var file = form.Files["file"];
                if (file is null || file.Length == 0) throw DomainException.BadRequest("missing file field");
                if (file.Length > MaxUploadBytes) throw DomainException.BadRequest("file too large (max 100 MB)");

                var id = Guid.NewGuid().ToString();

                // Sniff MIME from the actual bytes (never trust the client header).
                string mime;
                await using (var sniff = file.OpenReadStream())
                {
                    var head = new byte[512];
                    var read = await sniff.ReadAsync(head.AsMemory(0, 512), ctx.RequestAborted);
                    mime = MimeSniffer.Sniff(head.AsSpan(0, read), file.ContentType);
                }
                await using (var save = file.OpenReadStream())
                {
                    await storage.SaveAsync(id, save, ctx.RequestAborted);
                }

                try
                {
                    await mediator.Send(new CreateAttachmentCommand(id, file.FileName, id, mime, file.Length, null, null), ctx.RequestAborted);
                }
                catch
                {
                    storage.Delete(id);
                    throw;
                }

                return new UploadResultDto(id, file.FileName, file.Length, mime, $"/api/v1/files/{id}", null, null);
            }).DisableAntiforgery();

        // POST /api/v1/uploads/voice — a recorded voice message. The raw clip (webm/ogg/mp4,
        // whatever the recorder produced) is normalized to m4a/AAC so EVERY platform can play it,
        // and a waveform + duration are extracted. Falls back to storing the raw clip only if
        // ffmpeg can't decode it, so a send never hard-fails.
        app.MapPost("/api/v1/uploads/voice",
            async (HttpContext ctx, ICurrentUser current, IFileStorage storage,
                   Outcome.Infrastructure.Media.VoiceTranscoder transcoder, ISender mediator) =>
            {
                if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");

                var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
                if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxUploadBytes;

                if (!ctx.Request.HasFormContentType) throw DomainException.BadRequest("expected a multipart form");
                var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
                var file = form.Files["file"];
                if (file is null || file.Length == 0) throw DomainException.BadRequest("missing file field");
                if (file.Length > MaxUploadBytes) throw DomainException.BadRequest("recording too large (max 100 MB)");

                byte[] raw;
                await using (var s = file.OpenReadStream())
                {
                    using var ms = new MemoryStream();
                    await s.CopyToAsync(ms, ctx.RequestAborted);
                    raw = ms.ToArray();
                }

                var id = Guid.NewGuid().ToString();
                var result = await transcoder.TranscodeAsync(raw, ctx.RequestAborted);

                string mime; long size; int? durationMs; string? waveform;
                if (result is not null)
                {
                    mime = "audio/mp4"; size = result.M4a.Length;
                    durationMs = result.DurationMs; waveform = result.WaveformJson;
                    await using var outMs = new MemoryStream(result.M4a);
                    await storage.SaveAsync(id, outMs, ctx.RequestAborted);
                }
                else
                {
                    // ffmpeg absent / undecodable — keep the raw clip so the send still works.
                    mime = string.IsNullOrWhiteSpace(file.ContentType) ? "audio/webm" : file.ContentType;
                    size = raw.Length; durationMs = null; waveform = null;
                    await using var outMs = new MemoryStream(raw);
                    await storage.SaveAsync(id, outMs, ctx.RequestAborted);
                }

                try
                {
                    await mediator.Send(new CreateAttachmentCommand(
                        id, "voice-message.m4a", id, mime, size, null, null, durationMs, waveform), ctx.RequestAborted);
                }
                catch { storage.Delete(id); throw; }

                return new UploadResultDto(id, "voice-message.m4a", size, mime, $"/api/v1/files/{id}", null, null, durationMs, waveform);
            }).DisableAntiforgery();

        // GET /api/v1/files/{id} — public (ids are unguessable UUIDs).
        app.MapGet("/api/v1/files/{id}", async (string id, HttpContext ctx, IAttachmentRepository attachments, IFileStorage storage) =>
        {
            var att = await attachments.GetByIdAsync(id, ctx.RequestAborted);
            if (att is null) return Results.NotFound();

            // The id is the content's immutable identity (unguessable UUID, bytes never change),
            // so it doubles as a strong ETag. A browser reload revalidates with If-None-Match even
            // for an immutable resource — without a validator the server had to re-send the whole
            // file every time; now it answers 304 and the bytes stay in the browser's cache.
            var etag = $"\"{id}\"";
            ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
            ctx.Response.Headers.ETag = etag;
            if (ctx.Request.Headers.IfNoneMatch.Count > 0 && ctx.Request.Headers.IfNoneMatch.ToString() == etag)
                return Results.StatusCode(StatusCodes.Status304NotModified);

            var stream = storage.OpenRead(att.StoredAs);
            if (stream is null) return Results.NotFound();

            ctx.Response.Headers.ContentDisposition = ContentDisposition("inline", att.Filename);
            return Results.Stream(stream, att.MimeType, enableRangeProcessing: true);
        });
    }

    /// <summary>
    /// Build an RFC 6266 Content-Disposition value that is safe for HTTP headers (ASCII only).
    /// Non-ASCII filenames (e.g. Cyrillic "Снимок экрана.png") would otherwise throw
    /// "Invalid non-ASCII or control character in header". We emit an ASCII-sanitized
    /// <c>filename</c> fallback plus an RFC 5987 <c>filename*=UTF-8''…</c> for modern browsers.
    /// </summary>
    private static string ContentDisposition(string disposition, string filename)
    {
        var ascii = new string((filename ?? string.Empty)
            .Select(c => c < 0x20 || c > 0x7E || c == '"' || c == '\\' ? '_' : c).ToArray());
        if (ascii.Length == 0) ascii = "file";
        var encoded = Uri.EscapeDataString(filename ?? string.Empty);
        return $"{disposition}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}";
    }
}

internal static class MimeSniffer
{
    public static string Sniff(ReadOnlySpan<byte> b, string? fallback)
    {
        if (b.Length >= 4 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 4 && b[0] == (byte)'G' && b[1] == (byte)'I' && b[2] == (byte)'F' && b[3] == (byte)'8') return "image/gif";
        if (b.Length >= 12 && b[0] == (byte)'R' && b[1] == (byte)'I' && b[2] == (byte)'F' && b[3] == (byte)'F'
            && b[8] == (byte)'W' && b[9] == (byte)'E' && b[10] == (byte)'B' && b[11] == (byte)'P') return "image/webp";
        if (b.Length >= 4 && b[0] == (byte)'%' && b[1] == (byte)'P' && b[2] == (byte)'D' && b[3] == (byte)'F') return "application/pdf";
        return string.IsNullOrWhiteSpace(fallback) ? "application/octet-stream" : fallback!;
    }
}
