namespace Outcome.Shared.Abstractions.Persistence;

/// <summary>A bug report as surfaced to the client (reporter name resolved for the admin view).</summary>
public sealed record BugReportDto(
    long Id, long ReporterId, string ReporterName, string Title, string Description,
    string Status, IReadOnlyList<string> Attachments, DateTime CreatedAt, DateTime UpdatedAt);

/// <summary>"Send To Developer" bug reports: any user submits, the instance owner triages.</summary>
public interface IBugReportRepository
{
    /// <summary>Create a report for <paramref name="reporterId"/>. Returns the stored row.</summary>
    Task<BugReportDto> CreateAsync(
        long reporterId, string title, string description, IReadOnlyList<string> attachments, CancellationToken ct = default);

    /// <summary>The user's own reports, newest first.</summary>
    Task<IReadOnlyList<BugReportDto>> ListForUserAsync(long userId, CancellationToken ct = default);

    /// <summary>Every report (owner triage view), newest first.</summary>
    Task<IReadOnlyList<BugReportDto>> ListAllAsync(int limit = int.MaxValue, int offset = 0, CancellationToken ct = default);
    Task<int> CountAsync(CancellationToken ct = default);

    /// <summary>Move a report to a new status. False if the id doesn't exist.</summary>
    Task<bool> SetStatusAsync(long id, string status, CancellationToken ct = default);
}
