using Outcome.Shared.Abstractions.Security;
using System.Net;
using System.Net.Sockets;

namespace Outcome.Api.Endpoints;

/// <summary>
/// Per-client rate limiting that survives not knowing who the client is.
///
/// Written after production spent a day refusing everyone. The home router in front of this
/// deployment rewrites the source address of every inbound packet, so each visitor — from any
/// network on earth — reaches the proxy as the gateway, 192.168.1.1. The forwarded-headers chain
/// then faithfully passes that one address along. Nothing is misconfigured; the information is
/// destroyed below HTTP, before anything here can see it.
///
/// The damage is that a limit keyed on that address is not per-client at all. It is a SECOND
/// GLOBAL limit whose ceiling was sized for one person, shared by everybody — which is how a
/// five-joins-per-minute guest limit became "the team cannot get into the call", and a
/// three-per-minute registration limit became "registration is closed".
///
/// So: key on the address when it identifies somebody, and when it does not, fall back to one
/// shared bucket with a ceiling raised to match what it now covers. That keeps a real ceiling —
/// the endpoints without their own global backstop still get one — without pretending that a
/// number sized for a single visitor can stand in for the whole internet.
/// </summary>
internal static class ClientRate
{
    /// <summary>How much to raise a per-client ceiling by when it has to cover every client at
    /// once. Deliberately a single knob: where an endpoint already declares its own instance-wide
    /// limit, that one is lower and keeps winning, so this only has to backstop the endpoints
    /// that declare none.</summary>
    private const int SharedCeilingFactor = 40;

    /// <summary>The caller's address, or null when this deployment cannot know it. A loopback or
    /// private address means the chain never produced a real client address: on a NAT'd host
    /// every caller looks identical, and keying on identical is worse than not keying at all.</summary>
    public static string? Of(HttpContext ctx)
    {
        var ip = ctx.Connection.RemoteIpAddress;
        if (ip is null) return null;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return Identifies(ip) ? ip.ToString() : null;
    }

    public static bool Allow(IRateLimiter limiter, HttpContext ctx, string prefix, int limit, TimeSpan window)
    {
        var ip = Of(ctx);
        return ip is not null
            ? limiter.Allow($"{prefix}:{ip}", limit, window)
            : limiter.Allow($"{prefix}:no-client-address", limit * SharedCeilingFactor, window);
    }

    private static bool Identifies(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return false;
        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
            return !ip.IsIPv6LinkLocal && !ip.IsIPv6SiteLocal && (ip.GetAddressBytes()[0] & 0xFE) != 0xFC;

        var b = ip.GetAddressBytes();
        return b[0] switch
        {
            10 => false,
            127 => false,
            172 => b[1] is < 16 or > 31,
            192 => b[1] != 168,
            169 => b[1] != 254,           // link-local
            0 or 255 => false,
            _ => true,
        };
    }
}
