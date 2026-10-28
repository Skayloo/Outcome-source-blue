using MediatR;
using Microsoft.AspNetCore.Http.Features;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Application.Uploads;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Infrastructure.Media;

namespace Outcome.Api.Endpoints;

/// <summary>
/// A user's own GIF reactions (W3GWG-25 stage 3): upload, list, delete. The library lives with the
/// account — every device, every server — and a GIF is fired into a call as a LiveKit data
/// message carrying its file path (lib/voiceReactions.ts, VoiceService.sendGif).
///
/// Not the general upload: that one re-encodes a picture to a single still frame whenever the
/// still is smaller, which for an animation is always. A GIF or WebP is stored exactly as sent; a
/// short video (what Telegram calls a GIF is an MP4) is turned into an animated WebP first
/// (ReactionAnimator), so every client and the guest page keep drawing a picture.
/// </summary>
public static class GifEndpoints
{
    /// <summary>The owner's limits: GIF or WebP, by content, up to 5 MB, 50 per account — and since
    /// 2026-10-28 a video (MP4, MOV, WebM) up to 20 MB, whose animation is kept to the same 5 MB.</summary>
    private const long MaxGifBytes = 5L * 1024 * 1024;
    private const long MaxVideoBytes = 20L * 1024 * 1024;
    private const int MaxGifsPerUser = 50;

    public static void MapGifEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/gifs", async (ICurrentUser current, IUserGifRepository gifs) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var list = await gifs.ListAsync(current.UserId);
            return Results.Json(list.Select(g => new { id = g.Id, url = g.Path, mime = g.Mime, size = g.Size }));
        });

        app.MapPost("/api/v1/gifs", async (HttpContext ctx, ICurrentUser current, IUserGifRepository gifs,
            IFileStorage storage, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            AllowVideoBody(ctx);
            if (await gifs.CountAsync(current.UserId) >= MaxGifsPerUser)
                throw DomainException.BadRequest($"you can keep at most {MaxGifsPerUser} GIFs — delete one first");
            var (bytes, mime) = await PrepareAsync(ctx);

            var id = Guid.NewGuid().ToString();
            await using (var save = new MemoryStream(bytes, writable: false))
                await storage.SaveAsync(id, save, ctx.RequestAborted);
            UserGif gif;
            try
            {
                var name = mime == "image/gif" ? "reaction.gif" : "reaction.webp";
                await mediator.Send(new CreateAttachmentCommand(id, name, id, mime, bytes.Length, null, null), ctx.RequestAborted);
                gif = await gifs.AddAsync(new UserGif
                {
                    UserId = current.UserId, Path = $"/api/v1/files/{id}", FileId = id, Mime = mime, Size = bytes.Length,
                });
            }
            catch
            {
                storage.Delete(id);
                throw;
            }
            return Results.Json(new { id = gif.Id, url = gif.Path, mime = gif.Mime, size = gif.Size });
        }).DisableAntiforgery();

        app.MapDelete("/api/v1/gifs/{id:long}", async (long id, ICurrentUser current, IUserGifRepository gifs, IFileStorage storage) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var gone = await gifs.RemoveAsync(current.UserId, id) ?? throw DomainException.NotFound("no such GIF");
            // The file goes with it — nothing else points at it — and a call that fires it after
            // this gets a 404, which every client shows as nothing.
            storage.Delete(gone.FileId);
            return Results.NoContent();
        });
    }

    /// <summary>A little over the video limit, so a file just past it is refused with the reason
    /// rather than cut off by Kestrel with a bare 413. Call before the form is read.</summary>
    internal static void AllowVideoBody(HttpContext ctx)
    {
        var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxVideoBytes + 64 * 1024;
    }

    /// <summary>The form's <c>file</c> as a reaction ready to show: a GIF or WebP as sent, a video as an
    /// animated WebP — at most 5 MB either way. The rules a member's library and a guest's one-off GIF
    /// share (GuestEndpoints).</summary>
    internal static async Task<(byte[] Bytes, string Mime)> PrepareAsync(HttpContext ctx)
    {
        var ct = ctx.RequestAborted;
        if (!ctx.Request.HasFormContentType) throw DomainException.BadRequest("expected a multipart form");
        var form = await ctx.Request.ReadFormAsync(ct);
        var file = form.Files["file"];
        if (file is null || file.Length == 0) throw DomainException.BadRequest("missing file field");
        if (file.Length > MaxVideoBytes) throw DomainException.BadRequest("the file is larger than 20 MB");

        // By content, never by the name or the client's header: a renamed JPEG is not a GIF — and
        // a "GIF" saved from Telegram is an MP4, whatever its name says.
        string mime;
        bool video;
        await using (var sniff = file.OpenReadStream())
        {
            var head = new byte[32];
            var read = await sniff.ReadAsync(head.AsMemory(0, 32), ct);
            mime = MimeSniffer.Sniff(head.AsSpan(0, read), null);
            video = mime is not ("image/gif" or "image/webp") && LooksLikeVideo(head.AsSpan(0, read), mime);
        }
        if (mime is not ("image/gif" or "image/webp") && !video)
            throw DomainException.BadRequest("only GIF, WebP or a short MP4/MOV video can be added");
        if (!video)
        {
            if (file.Length > MaxGifBytes) throw DomainException.BadRequest("the GIF is larger than 5 MB");
            using var copy = new MemoryStream((int)file.Length);
            await using (var src = file.OpenReadStream()) await src.CopyToAsync(copy, ct);
            return (copy.ToArray(), mime);
        }

        string? temp = null, animated = null;
        try
        {
            temp = Path.Combine(Path.GetTempPath(), $"gifsrc_{Guid.NewGuid():N}");
            await using (var src = file.OpenReadStream())
            await using (var dst = File.Create(temp))
                await src.CopyToAsync(dst, ct);
            animated = await ReactionAnimator.ToWebpAsync(temp, MaxGifBytes, ct)
                ?? throw DomainException.BadRequest("this video could not be turned into an animation");
            return (await File.ReadAllBytesAsync(animated, ct), "image/webp");
        }
        finally
        {
            foreach (var f in new[] { temp, animated })
                if (f is not null) try { File.Delete(f); } catch { /* temp file */ }
        }
    }

    /// <summary>An ISO-BMFF video (an <c>ftyp</c> box whose brand is not a HEIF/AVIF picture, which the
    /// sniffer has already called image/heic or which carries an image brand), a QuickTime file
    /// starting with a bare atom, or WebM/Matroska.</summary>
    private static bool LooksLikeVideo(ReadOnlySpan<byte> b, string sniffed)
    {
        if (sniffed == "image/heic" || b.Length < 12) return false;
        var box = System.Text.Encoding.ASCII.GetString(b[4..8]);
        if (box == "ftyp")
            return System.Text.Encoding.ASCII.GetString(b[8..12]) is not ("avif" or "avis" or "mif1" or "msf1");
        if (box is "moov" or "mdat" or "wide" or "free" or "skip" or "pnot") return true;
        return b[0] == 0x1A && b[1] == 0x45 && b[2] == 0xDF && b[3] == 0xA3;
    }
}
