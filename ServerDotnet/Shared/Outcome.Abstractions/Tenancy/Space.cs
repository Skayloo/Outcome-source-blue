using Microsoft.Extensions.DependencyInjection;

namespace Outcome.Infrastructure.Tenancy;

/// <summary>
/// A SPACE is a tenant: its own database, its own users, its own servers, its own SSO. It is
/// NOT the same thing as a <c>server</c> — a server is what a user creates INSIDE a space
/// (channels, members, roles). Two spaces share the Postgres instance and nothing else, so
/// "can a CoreOTC user DM someone on outcome.ru" is not a question of query hygiene: there
/// is no row to find.
/// </summary>
/// <param name="Domain">The host this space answers on. Null on the root space, which takes
/// everything no other space claims.</param>
public sealed record Space(long Id, string Slug, string Name, string? Domain, string DbName, bool Active)
{
    public bool IsRoot => Id == RootId;
    public const long RootId = 1;
}

public static class SpaceScopes
{
    /// <summary>
    /// A DI scope pinned to a space, for work that has no HTTP request to resolve from:
    /// live WebSocket connections, background sweeps, provisioning. Without this the
    /// DbContext has no database to open — which is the point: nothing reads data without
    /// saying whose data it is.
    /// </summary>
    public static IServiceScope CreateScopeFor(this IServiceScopeFactory factory, Space space)
    {
        var scope = factory.CreateScope();
        scope.ServiceProvider.GetRequiredService<ICurrentSpace>().Set(space);
        return scope;
    }

    /// <inheritdoc cref="CreateScopeFor"/>
    public static AsyncServiceScope CreateAsyncScopeFor(this IServiceScopeFactory factory, Space space)
    {
        var scope = factory.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<ICurrentSpace>().Set(space);
        return scope;
    }
}

/// <summary>The space serving the current request. Scoped; set by the resolution middleware.</summary>
public interface ICurrentSpace
{
    Space Space { get; }
    void Set(Space space);
}

public sealed class CurrentSpaceContext : ICurrentSpace
{
    private Space? _space;

    public Space Space => _space
        ?? throw new InvalidOperationException("no space resolved for this scope — SpaceResolutionMiddleware must run first");

    public void Set(Space space) => _space = space;
}
