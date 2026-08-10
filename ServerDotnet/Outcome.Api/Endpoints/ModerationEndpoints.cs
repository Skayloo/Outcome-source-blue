using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

/// <summary>
/// User-side moderation — the pair App Review's UGC guideline (1.2) demands:
/// blocking a user (cuts DMs/calls/friend-requests both ways; enforcement lives in the
/// respective handlers) and reporting a message into the admin moderation inbox.
/// </summary>
public static class ModerationEndpoints
{
    public sealed record ReportBody(string? Reason);
    public sealed record SetReportStatusBody(string Status);

    private const int MaxReason = 1000;

    public static void MapModerationEndpoints(this IEndpointRouteBuilder app)
    {
        // ── Blocks ───────────────────────────────────────────────────────────────
        app.MapPut("/api/v1/users/{id:long}/block", async (long id, ICurrentUser current,
            IBlockRepository blocks, IUserRepository users, IFriendRepository friends) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (id == current.UserId) throw DomainException.BadRequest("cannot block yourself");
            _ = await users.GetByIdAsync(id) ?? throw DomainException.NotFound("user not found");
            await blocks.BlockAsync(current.UserId, id);
            // Blocking also severs an existing friendship / pending request — being "friends"
            // with someone you blocked is a contradiction every platform resolves this way.
            await friends.RemoveAsync(current.UserId, id);
            return Results.NoContent();
        });

        app.MapDelete("/api/v1/users/{id:long}/block", async (long id, ICurrentUser current, IBlockRepository blocks) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (!await blocks.UnblockAsync(current.UserId, id)) throw DomainException.NotFound("user is not blocked");
            return Results.NoContent();
        });

        app.MapGet("/api/v1/users/blocked", async (ICurrentUser current, IBlockRepository blocks) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var list = await blocks.ListForUserAsync(current.UserId);
            return list.Select(b => new { user_id = b.UserId, username = b.Username, avatar = b.Avatar, created_at = b.CreatedAt });
        });

        // ── Reports ──────────────────────────────────────────────────────────────
        app.MapPost("/api/v1/messages/{id:long}/report", async (long id, ReportBody? body, HttpContext ctx,
            ICurrentUser current, IMessageRepository messages, IChannelRepository channels,
            IDmRepository dms, IServerRepository servers, IMessageReportRepository reports, IRateLimiter limiter) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            // Reports are cheap to file and land on a human — throttle per reporter.
            if (!limiter.Allow($"report:{current.UserId}", 10, TimeSpan.FromMinutes(5)))
                throw new DomainException("RATE_LIMITED", 429, "too many reports, please slow down");

            var msg = await messages.GetByIdAsync(id) ?? throw DomainException.NotFound("message not found");
            if (msg.UserId == current.UserId) throw DomainException.BadRequest("cannot report your own message");

            // The reporter must be able to SEE the message: a DM participant, or a member of
            // the server the channel belongs to — otherwise this endpoint would leak content.
            var channel = await channels.GetByIdAsync(msg.ChannelId) ?? throw DomainException.NotFound("message not found");
            var canSee = channel.Type == "dm"
                ? await dms.IsParticipantAsync(current.UserId, channel.Id)
                : channel.ServerId is { } sid && await servers.IsMemberAsync(sid, current.UserId);
            if (!canSee) throw DomainException.NotFound("message not found");

            var reason = (body?.Reason ?? string.Empty).Trim();
            if (reason.Length > MaxReason) reason = reason[..MaxReason];

            await reports.CreateAsync(new MessageReport
            {
                ReporterId = current.UserId,
                MessageId = msg.Id,
                AuthorId = msg.UserId,
                Content = msg.Content, // snapshot: the author may edit/delete afterwards
                Reason = reason,
                CreatedAt = DateTime.UtcNow,
            });
            return Results.Json(new { ok = true }, statusCode: 201);
        });

        // ── Admin moderation inbox ───────────────────────────────────────────────
        app.MapGet("/api/v1/admin/reports", async (int? limit, int? offset, HttpContext ctx,
            ICurrentUser current, IMessageReportRepository reports) =>
        {
            RequireAdmin(current);
            var page = await reports.ListAllAsync(limit ?? int.MaxValue, offset ?? 0);
            ctx.Response.Headers["X-Total-Count"] = (await reports.CountAsync()).ToString();
            return page.Select(r => new
            {
                id = r.Id,
                reporter_id = r.ReporterId, reporter_name = r.ReporterName,
                message_id = r.MessageId,
                author_id = r.AuthorId, author_name = r.AuthorName,
                content = r.Content, reason = r.Reason,
                status = r.Status, created_at = r.CreatedAt,
            });
        });

        app.MapPatch("/api/v1/admin/reports/{id:long}/status", async (long id, SetReportStatusBody body,
            ICurrentUser current, IMessageReportRepository reports) =>
        {
            RequireAdmin(current);
            var status = (body.Status ?? string.Empty).Trim();
            if (!MessageReport.IsValidStatus(status))
                throw DomainException.BadRequest("status must be one of: open, resolved, dismissed");
            if (!await reports.SetStatusAsync(id, status))
                throw DomainException.NotFound("report not found");
            return Results.NoContent();
        });
    }

    private static void RequireAdmin(ICurrentUser current)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        if ((current.Permissions & Outcome.Domain.Permissions.Permission.Administrator) == 0)
            throw DomainException.Forbidden("administrator only");
    }
}
