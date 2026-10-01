using MediatR;
using Microsoft.AspNetCore.Http.Features;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Application.Uploads;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

/// <summary>
/// A user's own GIF reactions (W3GWG-25 stage 3): upload, list, delete. The library lives with the
/// account — every device, every server — and a GIF is fired into a call as a LiveKit data
/// message carrying its file path (lib/voiceReactions.ts, VoiceService.sendGif).
///
/// Not the general upload: that one re-encodes a picture to a single still frame whenever the
/// still is smaller, which for an animation is always. These bytes are stored exactly as sent.
/// </summary>
public static class GifEndpoints
{
    /// <summary>The owner's limits: GIF or WebP, by content, up to 5 MB, 50 per account.</summary>
    private const long MaxGifBytes = 5L * 1024 * 1024;
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
            // A little over the limit, so a file just past it is refused with the reason rather
            // than cut off by Kestrel with a bare 413.
            var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxGifBytes + 64 * 1024;

            if (await gifs.CountAsync(current.UserId) >= MaxGifsPerUser)
                throw DomainException.BadRequest($"you can keep at most {MaxGifsPerUser} GIFs — delete one first");
            if (!ctx.Request.HasFormContentType) throw DomainException.BadRequest("expected a multipart form");
            var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
            var file = form.Files["file"];
            if (file is null || file.Length == 0) throw DomainException.BadRequest("missing file field");
            if (file.Length > MaxGifBytes) throw DomainException.BadRequest("the GIF is larger than 5 MB");

            // By content, never by the name or the client's header: a renamed JPEG is not a GIF.
            string mime;
            await using (var sniff = file.OpenReadStream())
            {
                var head = new byte[16];
                var read = await sniff.ReadAsync(head.AsMemory(0, 16), ctx.RequestAborted);
                mime = MimeSniffer.Sniff(head.AsSpan(0, read), null);
            }
            if (mime is not ("image/gif" or "image/webp"))
                throw DomainException.BadRequest("only GIF and WebP images can be added");

            var id = Guid.NewGuid().ToString();
            await using (var save = file.OpenReadStream())
                await storage.SaveAsync(id, save, ctx.RequestAborted);
            UserGif gif;
            try
            {
                var name = mime == "image/gif" ? "reaction.gif" : "reaction.webp";
                await mediator.Send(new CreateAttachmentCommand(id, name, id, mime, file.Length, null, null), ctx.RequestAborted);
                gif = await gifs.AddAsync(new UserGif
                {
                    UserId = current.UserId, Path = $"/api/v1/files/{id}", FileId = id, Mime = mime, Size = file.Length,
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
}
