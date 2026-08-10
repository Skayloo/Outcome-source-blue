using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class BugReportRepository(OutcomeDbContext db) : IBugReportRepository
{
    public async Task<BugReportDto> CreateAsync(
        long reporterId, string title, string description, IReadOnlyList<string> attachments, CancellationToken ct = default)
    {
        var report = new BugReport
        {
            ReporterId = reporterId,
            Title = title,
            Description = description,
            Status = BugReport.StatusNew,
            Attachments = attachments.ToList(),
        };
        db.BugReports.Add(report);
        await db.SaveChangesAsync(ct);

        var name = await db.Users.AsNoTracking()
            .Where(u => u.Id == reporterId).Select(u => u.UserName).FirstOrDefaultAsync(ct);
        return ToDto(report, name);
    }

    public Task<IReadOnlyList<BugReportDto>> ListForUserAsync(long userId, CancellationToken ct = default) =>
        QueryDtos(db.BugReports.AsNoTracking().Where(r => r.ReporterId == userId), ct);

    public Task<IReadOnlyList<BugReportDto>> ListAllAsync(int limit = int.MaxValue, int offset = 0, CancellationToken ct = default) =>
        // Page BEFORE the user join: QueryDtos re-sorts, and both orderings are by r.Id desc.
        QueryDtos(db.BugReports.AsNoTracking().OrderByDescending(r => r.Id).Skip(offset).Take(limit), ct);

    public Task<int> CountAsync(CancellationToken ct = default) =>
        db.BugReports.AsNoTracking().CountAsync(ct);

    public async Task<bool> SetStatusAsync(long id, string status, CancellationToken ct = default)
    {
        var updated = await db.BugReports.Where(r => r.Id == id)
            .ExecuteUpdateAsync(s => s
                .SetProperty(r => r.Status, status)
                .SetProperty(r => r.UpdatedAt, DateTime.UtcNow), ct);
        return updated > 0;
    }

    // Reporter username is joined in so the owner's triage list shows who filed each report.
    private async Task<IReadOnlyList<BugReportDto>> QueryDtos(IQueryable<BugReport> q, CancellationToken ct)
    {
        var rows = await q
            .Join(db.Users.AsNoTracking(), r => r.ReporterId, u => u.Id, (r, u) => new { r, u.UserName })
            .OrderByDescending(x => x.r.Id)
            .ToListAsync(ct);
        return rows.Select(x => ToDto(x.r, x.UserName)).ToList();
    }

    private static BugReportDto ToDto(BugReport r, string? reporterName) => new(
        r.Id, r.ReporterId, reporterName ?? "", r.Title, r.Description, r.Status,
        r.Attachments, r.CreatedAt, r.UpdatedAt);
}
