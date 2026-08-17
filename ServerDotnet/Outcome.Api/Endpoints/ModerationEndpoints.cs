using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Api.Realtime;
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
    /// <summary>hide | delete | dismiss, plus the note sent to the reporter when dismissing.</summary>
    public sealed record ReportActionBody(string? Action, string? Note);

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
                ChannelId = msg.ChannelId,
                ServerId = channel.ServerId,
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
            return page.Select(ToDto);
        });

        // ── A server's own moderation queue ──────────────────────────────────────
        // The instance owner is not the only person who should be answering complaints: a
        // report about a message in somebody's server is that server's problem first. Anyone
        // holding ManageMessages there sees it and can act on it, scoped to their own server —
        // a direct message carries no server and never appears in one of these.
        app.MapGet("/api/v1/servers/reports", async (int? limit, int? offset, HttpContext ctx,
            ICurrentUser current, ICurrentServer srv, IMessageReportRepository reports) =>
        {
            RequireModerator(current);
            var page = await reports.ListForServerAsync(srv.ServerId, limit ?? int.MaxValue, offset ?? 0);
            ctx.Response.Headers["X-Total-Count"] = (await reports.CountForServerAsync(srv.ServerId)).ToString();
            return Results.Ok(page.Select(ToDto));
        });

        // ── Acting on a report ───────────────────────────────────────────────────
        // A queue you cannot act on is a list of complaints. Taking the message down closes the
        // report for good — a handled complaint that can drift back to "open" is how a queue
        // stops meaning anything. Answering the reporter marks it resolved instead: nothing was
        // removed, so nothing is settled beyond one moderator's reading.
        //
        //   hide     the message stays as a tombstone, so the removal is visible in place
        //   delete   the row goes, and nothing is left of it anywhere
        //   dismiss  nothing was wrong with it; the reporter is told so, and shown which
        //            message the answer is about by being FORWARDED it
        app.MapPost("/api/v1/admin/reports/{id:long}/action", async (long id, ReportActionBody body,
            ICurrentUser current, ICurrentServer srv, IMessageReportRepository reports,
            IMessageRepository messages, IChannelRepository channels, IDmRepository dms,
            IUserRepository users, IConnectionRegistry hub, IAuditRepository audit) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var action = (body.Action ?? string.Empty).Trim().ToLowerInvariant();
            if (action is not ("hide" or "delete" or "dismiss"))
                throw DomainException.BadRequest("action must be one of: hide, delete, dismiss");

            var report = await reports.GetByIdAsync(id) ?? throw DomainException.NotFound("report not found");

            // Two ways in, and they are not the same door. A server's moderator may act on
            // complaints about THEIR server — checked against the report's own snapshot of
            // where the message lived, never a server id the caller supplies. Everything else,
            // direct messages included, stays with whoever runs the instance.
            var isAdmin = (current.Permissions & Outcome.Domain.Permissions.Permission.Administrator) != 0;
            var mineToModerate = report.ServerId is { } rsid
                && rsid == srv.ServerId
                && (current.Permissions & Outcome.Domain.Permissions.Permission.ManageMessages) != 0;
            if (!isAdmin && !mineToModerate)
                throw DomainException.Forbidden("you cannot act on this report");

            if (report.Status == MessageReport.StatusClosed)
                throw DomainException.BadRequest("this report has already been acted on");

            var msg = await messages.GetByIdAsync(report.MessageId);

            if (action is "hide" or "delete" && msg is not null)
            {
                var channel = await channels.GetByIdAsync(msg.ChannelId);
                var purge = action == "delete";
                var gone = purge
                    ? await messages.PurgeAsync(msg.Id)
                    : await messages.DeleteAsync(msg.Id, current.UserId, isMod: true);
                if (gone)
                {
                    var frame = WsFrames.ChatDeleted(msg.Id, msg.ChannelId, purge);
                    if (channel?.Type == "dm")
                    {
                        // No server behind a DM, so a broadcast reaches nobody and the peer goes
                        // on showing something that is not there any more.
                        foreach (var pid in await dms.GetParticipantIdsAsync(msg.ChannelId))
                            await hub.SendToUserAsync(pid, frame);
                    }
                    else if (channel?.ServerId is { } sid)
                    {
                        await hub.BroadcastToServerAsync(sid, frame);
                    }
                }
            }

            if (action == "dismiss")
            {
                // Answer the person who reported it, in a direct message, from whoever is acting.
                // The reported message is FORWARDED along with the note rather than linked: a
                // link would need a route the client does not have, while forwarding already
                // carries the content and says where it came from.
                var note = (body.Note ?? string.Empty).Trim();
                if (note.Length > MaxReason) note = note[..MaxReason];
                if (note.Length == 0) note = "Reviewed: this message does not break the rules.";

                var author = await users.GetByIdAsync(report.AuthorId);
                var channelId = await dms.FindChannelAsync(current.UserId, report.ReporterId)
                                ?? await dms.CreateChannelAsync(current.UserId, report.ReporterId);
                // Both sides must have it OPEN, or the answer lands in a conversation the
                // reporter cannot see.
                await dms.OpenAsync(current.UserId, channelId);
                await dms.OpenAsync(report.ReporterId, channelId);

                var (mid, ts) = await messages.CreateAsync(channelId, current.UserId, note, null,
                    forwardedFrom: author?.UserName);
                var me = await users.GetByIdAsync(current.UserId);
                var frame = WsFrames.ChatMessage(mid, channelId, current.UserId, me?.UserName ?? "admin",
                    me?.Avatar, "admin", note, null, ts, 0, null, author?.UserName);
                foreach (var pid in new[] { current.UserId, report.ReporterId })
                    await hub.SendToUserAsync(pid, frame);
            }

            // Removing the message ENDS the complaint — there is nothing left to argue about, so
            // that is the terminal status. Answering the reporter only means it was looked at
            // and found fine, which is "resolved": a label, still open to a second opinion.
            await reports.SetStatusAsync(id,
                action == "dismiss" ? MessageReport.StatusResolved : MessageReport.StatusClosed);
            await audit.AddAsync(current.UserId, $"report_{action}", "message", report.MessageId,
                msg is null ? "message was already gone" : $"report #{id} closed by {action}");
            return Results.NoContent();
        });

        app.MapPatch("/api/v1/admin/reports/{id:long}/status", async (long id, SetReportStatusBody body,
            ICurrentUser current, IMessageReportRepository reports) =>
        {
            RequireAdmin(current);
            var status = (body.Status ?? string.Empty).Trim();
            if (!MessageReport.IsSettableByHand(status))
                throw DomainException.BadRequest("status must be one of: open, resolved, dismissed");
            var report = await reports.GetByIdAsync(id) ?? throw DomainException.NotFound("report not found");
            // Closed is where a report ends. Letting a label move it back would undo the record
            // that something was actually done about it.
            if (report.Status == MessageReport.StatusClosed)
                throw DomainException.BadRequest("this report has been acted on and cannot be reopened");
            if (!await reports.SetStatusAsync(id, status))
                throw DomainException.NotFound("report not found");
            return Results.NoContent();
        });
    }

    /// <summary>Shape of a report on the wire — one definition, so the instance queue and a
    /// server's own queue cannot drift into showing different things.</summary>
    private static object ToDto(MessageReportDto r) => new
    {
        id = r.Id,
        reporter_id = r.ReporterId, reporter_name = r.ReporterName,
        message_id = r.MessageId,
        author_id = r.AuthorId, author_name = r.AuthorName,
        content = r.Content, reason = r.Reason,
        status = r.Status, created_at = r.CreatedAt,
    };

    /// <summary>Whoever moderates messages in the CURRENT server. The instance owner holds
    /// every permission, so this admits them too without a second branch.</summary>
    private static void RequireModerator(ICurrentUser current)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        if ((current.Permissions & Outcome.Domain.Permissions.Permission.ManageMessages) == 0)
            throw DomainException.Forbidden("you cannot moderate messages here");
    }

    private static void RequireAdmin(ICurrentUser current)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        if ((current.Permissions & Outcome.Domain.Permissions.Permission.Administrator) == 0)
            throw DomainException.Forbidden("administrator only");
    }
}
