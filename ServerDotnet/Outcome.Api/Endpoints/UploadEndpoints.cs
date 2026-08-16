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
            async (HttpContext ctx, ICurrentUser current, IFileStorage storage, ISender mediator,
                   IFileUrlSigner fileUrls) =>
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

                // A picture's shape travels with it. Without it a client cannot know how much
                // room to leave until it has decoded the bytes, so a chat opened from cold
                // lays every photo out at a guess and reflows when they land — which is
                // exactly what it looks like: the picture appears wrong, then corrects itself.
                int? width = null, height = null;
                if (mime.StartsWith("image/", StringComparison.Ordinal))
                {
                    byte[] raw;
                    await using (var s = file.OpenReadStream())
                    {
                        using var ms = new MemoryStream();
                        await s.CopyToAsync(ms, ctx.RequestAborted);
                        raw = ms.ToArray();
                    }
                    if (await Outcome.Infrastructure.Media.ImageProbe.MeasureAsync(raw, ctx.RequestAborted) is { } dim)
                        (width, height) = (dim.Width, dim.Height);

                    // A preview alongside the original. Avatars are drawn at thirty points and
                    // thumbnails at a few hundred, and both were costing whatever the camera
                    // produced — six megabytes to fill a square the size of a fingernail.
                    if (await Outcome.Infrastructure.Media.ImageProbe.PreviewAsync(raw, mime, ct: ctx.RequestAborted) is { } small)
                    {
                        await using var sm = new MemoryStream(small);
                        await storage.SaveAsync(PreviewKey(id), sm, ctx.RequestAborted);
                    }

                    // …and a SCREEN-sized one. The thumbnail is far too coarse to open, so the
                    // viewer was fetching the original — six megabytes of camera output to fill a
                    // window that cannot show a tenth of it, which is a wait measured in tens of
                    // seconds on anything but a fast line. 1600px is more than any display puts on
                    // a photo here, and costs a few hundred kilobytes. The original stays one
                    // click away for whoever actually wants it.
                    if (await Outcome.Infrastructure.Media.ImageProbe.PreviewAsync(raw, mime, MediumDim, ctx.RequestAborted) is { } medium)
                    {
                        await using var md = new MemoryStream(medium);
                        await storage.SaveAsync(MediumKey(id), md, ctx.RequestAborted);
                    }
                }

                try
                {
                    await mediator.Send(new CreateAttachmentCommand(id, file.FileName, id, mime, file.Length, width, height), ctx.RequestAborted);
                }
                catch
                {
                    storage.Delete(id);
                    throw;
                }

                return new UploadResultDto(id, file.FileName, file.Length, mime, fileUrls.Sign(id), null, null);
            }).DisableAntiforgery();

        // POST /api/v1/uploads/voice — a recorded voice message. The raw clip (webm/ogg/mp4,
        // whatever the recorder produced) is normalized to m4a/AAC so EVERY platform can play it,
        // and a waveform + duration are extracted. Falls back to storing the raw clip only if
        // ffmpeg can't decode it, so a send never hard-fails.
        app.MapPost("/api/v1/uploads/voice",
            async (HttpContext ctx, ICurrentUser current, IFileStorage storage,
                   Outcome.Infrastructure.Media.VoiceTranscoder transcoder, ISender mediator,
                   IFileUrlSigner fileUrls) =>
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

                return new UploadResultDto(id, "voice-message.m4a", size, mime, fileUrls.Sign(id), null, null, durationMs, waveform);
            }).DisableAntiforgery();

        // GET /api/v1/files/{id} — no session, but not public: the signed query is the credential.
        app.MapGet("/api/v1/files/{id}", async (string id, HttpContext ctx, IAttachmentRepository attachments,
            IFileStorage storage, IFileUrlSigner fileUrls, IUserRepository users) =>
        {
            // The link IS the credential — an <img src> carries no session — so it has to expire.
            // An id alone was a permanent one: anywhere it was ever forwarded, pasted or logged,
            // it kept working. NotFound rather than Forbidden on purpose: a 403 confirms the id
            // exists, which is the one bit an unsigned guess should not learn.
            // Avatars are the exception, and they have to be: the path is stored on the user row
            // and handed out from a dozen DTOs, so it cannot carry a signature that expires — and
            // it is shown to guests, who have no session to sign one with. Signing attachments
            // broke every existing avatar until this was here.
            if (!fileUrls.Verify(id, ctx.Request.Query["e"], ctx.Request.Query["s"])
                && !await users.IsAvatarAsync($"/api/v1/files/{id}", ctx.RequestAborted))
                return Results.NotFound();

            var att = await attachments.GetByIdAsync(id, ctx.RequestAborted);
            if (att is null) return Results.NotFound();

            // The id is the content's immutable identity (unguessable UUID, bytes never change),
            // so it doubles as a strong ETag. A browser reload revalidates with If-None-Match even
            // for an immutable resource — without a validator the server had to re-send the whole
            // file every time; now it answers 304 and the bytes stay in the browser's cache.
            var size = ctx.Request.Query["sz"].ToString();
            var etag = size is "sm" or "md" ? $"\"{id}-{size}\"" : $"\"{id}\"";
            ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
            ctx.Response.Headers.ETag = etag;
            if (ctx.Request.Headers.IfNoneMatch.Count > 0 && ctx.Request.Headers.IfNoneMatch.ToString() == etag)
                return Results.StatusCode(StatusCodes.Status304NotModified);

            // ?sz=sm asks for the downscaled copy. Missing (anything uploaded before previews
            // existed, or a picture ffmpeg would not take) simply falls through to the original,
            // which is exactly the behaviour everything had until now.
            Stream? stream = null;
            var servingPreview = false;
            if (size is "sm" or "md")
            {
                stream = storage.OpenRead(size == "sm" ? PreviewKey(att.StoredAs) : MediumKey(att.StoredAs));
                servingPreview = stream is not null;
            }
            stream ??= storage.OpenRead(att.StoredAs);
            if (stream is null) return Results.NotFound();

            // Never let an upload decide it is a document. The stored MIME type comes from the
            // client whenever MimeSniffer does not recognise the magic bytes, so a file uploaded
            // as text/html used to be served as text/html, inline, on this origin — a page with
            // script, reading the session token and the E2EE keys out of the browser's storage.
            //
            // Only what we render inline is served inline, with its own type; everything else is
            // a download of opaque bytes. The sandbox header is the second lock: it strips the
            // response of an origin, so even a type that slips through can run nothing and reach
            // nothing.
            var inline = InlineSafe.Contains(att.MimeType);
            ctx.Response.Headers.ContentSecurityPolicy = "sandbox; default-src 'none'";
            ctx.Response.Headers.ContentDisposition =
                ContentDisposition(inline ? "inline" : "attachment", att.Filename);
            // A generated copy is JPEG or PNG depending on whether the picture actually had
            // transparency, which the original's MIME type does not tell you — a screenshot is a
            // PNG with no alpha and comes back as JPEG. Read it off the bytes instead: with
            // nosniff set a wrong label is not a cosmetic mistake, the browser renders nothing.
            var contentType = servingPreview ? SniffImage(stream) : att.MimeType;
            return Results.Stream(stream, inline ? contentType : "application/octet-stream",
                enableRangeProcessing: true);
        });
    }

    /// <summary>The type of a generated copy, from its magic bytes. Falls back to JPEG, which
    /// is what everything but a transparent picture is written as.</summary>
    private static string SniffImage(Stream s)
    {
        if (!s.CanSeek) return "image/jpeg";
        Span<byte> head = stackalloc byte[4];
        var n = s.Read(head);
        s.Position = 0;
        return n >= 4 && head[0] == 0x89 && head[1] == 0x50 && head[2] == 0x4E && head[3] == 0x47
            ? "image/png"
            : "image/jpeg";
    }

    /// <summary>Where a picture's downscaled copy lives, next to the original.</summary>
    private static string PreviewKey(string id) => id + "_sm";

    /// <summary>Where a picture's screen-sized copy lives. Longest side <see cref="MediumDim"/>.</summary>
    private static string MediumKey(string id) => id + "_md";

    /// <summary>Longest side of the copy the viewer opens. Above any display this runs on, and
    /// roughly a twentieth of what a phone camera writes.</summary>
    private const int MediumDim = 1600;

    /// <summary>
    /// The only types the client renders in place, and therefore the only ones served with their
    /// own Content-Type. Nothing here can carry script: SVG is deliberately absent — it is an
    /// image everywhere except in a browser, where it is a document that can run JavaScript.
    /// PDF is absent for the same reason.
    /// </summary>
    private static readonly HashSet<string> InlineSafe = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/gif", "image/webp",
        "audio/mp4", "audio/mpeg", "audio/ogg", "audio/webm",
        "video/mp4", "video/webm", "video/quicktime",
    };

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
