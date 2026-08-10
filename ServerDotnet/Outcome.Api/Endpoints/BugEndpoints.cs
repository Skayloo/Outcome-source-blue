using Outcome.Infrastructure.Tenancy;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

/// <summary>
/// "Send To Developer" bug reports. Any authenticated user can file a report and list their own;
/// the instance owner (Administrator) lists all reports and changes their status. Screenshots ride
/// the normal upload pipeline — the client uploads via /api/v1/uploads and passes the returned
/// /api/v1/files/{id} URLs here.
/// </summary>
public static class BugEndpoints
{
    public sealed record CreateBugBody(string? Title, string Description, string[]? Attachments);
    public sealed record SetBugStatusBody(string Status);

    /// <summary>See AdminEndpoints.RequireInstanceAdmin — a space owner is an administrator
    /// inside their own space, which is not the same as running the instance.</summary>
    private static void RequireInstanceAdmin(ICurrentUser current, ICurrentSpace space)
    {
        RequireAdmin(current);
        if (!space.Space.IsRoot) throw DomainException.Forbidden("this belongs to the main instance");
    }

    private const int MaxAttachments = 8;
    private const int MaxDescription = 4000;
    private const int MaxTitle = 200;

    public static void MapBugEndpoints(this IEndpointRouteBuilder app)
    {
        // File a report — any authenticated user.
        app.MapPost("/api/v1/bugs", async (CreateBugBody body, ICurrentUser current, IBugReportRepository bugs) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var description = (body.Description ?? string.Empty).Trim();
            if (description.Length == 0) throw DomainException.BadRequest("description is required");
            if (description.Length > MaxDescription) throw DomainException.BadRequest($"description must be <= {MaxDescription} characters");
            var title = (body.Title ?? string.Empty).Trim();
            if (title.Length > MaxTitle) title = title[..MaxTitle];

            // Only accept our own upload URLs, capped — never store arbitrary client-supplied links.
            var attachments = (body.Attachments ?? Array.Empty<string>())
                .Where(a => !string.IsNullOrWhiteSpace(a) && a.StartsWith("/api/v1/files/", StringComparison.Ordinal))
                .Distinct()
                .Take(MaxAttachments)
                .ToList();

            var report = await bugs.CreateAsync(current.UserId, title, description, attachments);
            return Results.Json(Shape(report), statusCode: 201);
        });

        // The caller's own reports (newest first).
        app.MapGet("/api/v1/bugs/mine", async (ICurrentUser current, IBugReportRepository bugs) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var list = await bugs.ListForUserAsync(current.UserId);
            return list.Select(Shape).ToArray();
        });

        // ── Owner triage (Administrator only) ────────────────────────────────────
        app.MapGet("/api/v1/admin/bugs", async (int? limit, int? offset, HttpContext ctx, ICurrentUser current, ICurrentSpace space, IBugReportRepository bugs) =>
        {
            // Reports are addressed to whoever builds the product, not to a customer running
            // a space on it.
            RequireInstanceAdmin(current, space);
            var page = await bugs.ListAllAsync(limit ?? int.MaxValue, offset ?? 0);
            ctx.Response.Headers["X-Total-Count"] = (await bugs.CountAsync()).ToString();
            return page.Select(Shape).ToArray();
        });

        app.MapPatch("/api/v1/admin/bugs/{id:long}/status", async (long id, SetBugStatusBody body, ICurrentUser current, ICurrentSpace space, IBugReportRepository bugs) =>
        {
            RequireInstanceAdmin(current, space);
            var status = (body.Status ?? string.Empty).Trim();
            if (!BugReport.IsValidStatus(status))
                throw DomainException.BadRequest("status must be one of: new, in_progress, fixed");
            if (!await bugs.SetStatusAsync(id, status))
                throw DomainException.NotFound("bug report not found");
            return Results.NoContent();
        });
    }

    private static void RequireAdmin(ICurrentUser current)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        if ((current.Permissions & Outcome.Domain.Permissions.Permission.Administrator) == 0)
            throw DomainException.Forbidden("administrator only");
    }

    private static object Shape(BugReportDto r) => new
    {
        id = r.Id,
        reporter_id = r.ReporterId,
        reporter_name = r.ReporterName,
        title = r.Title,
        description = r.Description,
        status = r.Status,
        attachments = r.Attachments,
        created_at = r.CreatedAt,
        updated_at = r.UpdatedAt,
    };
}
