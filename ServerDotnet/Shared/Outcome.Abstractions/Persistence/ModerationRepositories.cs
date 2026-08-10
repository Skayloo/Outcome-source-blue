using Outcome.Domain.Entities;

namespace Outcome.Shared.Abstractions.Persistence;

/// <summary>A blocked user as shown in the requester's block list (username joined in).</summary>
public sealed record BlockedUserDto(long UserId, string Username, string? Avatar, DateTime CreatedAt);

/// <summary>A message report as shown in the admin moderation inbox — reporter and author
/// names joined in; content is the report-time snapshot, not the live message.</summary>
public sealed record MessageReportDto(
    long Id, long ReporterId, string ReporterName, long MessageId,
    long AuthorId, string AuthorName, string Content, string Reason,
    string Status, DateTime CreatedAt);

/// <summary>User-to-user blocks. "Either way" checks are the enforcement primitive: a pair
/// with a block in ANY direction cannot DM, call, or friend-request each other.</summary>
public interface IBlockRepository
{
    /// <summary>Idempotent — blocking twice is a no-op.</summary>
    Task BlockAsync(long blockerId, long blockedId, CancellationToken ct = default);
    /// <summary>False when there was nothing to lift.</summary>
    Task<bool> UnblockAsync(long blockerId, long blockedId, CancellationToken ct = default);
    Task<bool> IsBlockedEitherWayAsync(long a, long b, CancellationToken ct = default);
    Task<IReadOnlyList<BlockedUserDto>> ListForUserAsync(long userId, CancellationToken ct = default);
}

/// <summary>The moderation inbox: user reports of objectionable messages (App Review UGC 1.2).</summary>
public interface IMessageReportRepository
{
    Task<long> CreateAsync(MessageReport report, CancellationToken ct = default);
    Task<IReadOnlyList<MessageReportDto>> ListAllAsync(int limit = int.MaxValue, int offset = 0, CancellationToken ct = default);
    Task<int> CountAsync(CancellationToken ct = default);
    Task<bool> SetStatusAsync(long id, string status, CancellationToken ct = default);
}
