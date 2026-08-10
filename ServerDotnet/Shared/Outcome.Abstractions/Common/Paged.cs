namespace Outcome.Application.Common;

/// <summary>One page of an admin list plus the unpaged total. Endpoints surface the total
/// via the <c>X-Total-Count</c> response header so the body stays a plain array — existing
/// consumers that never pass limit/offset (e.g. the mobile admin) keep working unchanged.</summary>
public sealed record Paged<T>(IReadOnlyList<T> Items, int Total);
