using Outcome.Shared.Abstractions.Security;

namespace Outcome.Api.Security;

/// <summary>Scoped holder for the active server (tenant) of the current request.</summary>
public sealed class CurrentServerContext : ICurrentServer
{
    public long ServerId { get; private set; } = 1;
    public void Set(long serverId) => ServerId = serverId;
}
