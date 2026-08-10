using System.Net.WebSockets;
using Microsoft.Extensions.Options;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Api.Realtime;

/// <summary>
/// Reverse-proxies /livekit/* (WebSocket + HTTP) to the LiveKit server, so browser clients
/// reach LiveKit through the same origin (avoids mixed-content). Mirrors Server/api/livekit_proxy.go.
/// </summary>
public static class LiveKitProxy
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private static readonly HashSet<string> Blocked = new(StringComparer.OrdinalIgnoreCase) { "admin", "metrics", "debug", "twirp" };

    public static async Task HandleAsync(HttpContext ctx)
    {
        var opt = ctx.RequestServices.GetRequiredService<IOptions<VoiceOptions>>().Value;
        var internalUrl = string.IsNullOrEmpty(opt.LiveKitInternalUrl) ? opt.LiveKitUrl : opt.LiveKitInternalUrl;

        var fullPath = ctx.Request.Path.Value ?? "/livekit";
        var subPath = fullPath.Length > "/livekit".Length ? fullPath["/livekit".Length..] : "/";
        if (subPath.Length == 0) subPath = "/";

        foreach (var seg in subPath.Split('/', StringSplitOptions.RemoveEmptyEntries))
            if (Blocked.Contains(seg)) { ctx.Response.StatusCode = StatusCodes.Status403Forbidden; return; }

        var secure = internalUrl.StartsWith("wss") || internalUrl.StartsWith("https");
        var host = internalUrl.Contains("://") ? internalUrl[(internalUrl.IndexOf("://", StringComparison.Ordinal) + 3)..] : internalUrl;
        var query = ctx.Request.QueryString.Value ?? string.Empty;

        if (ctx.WebSockets.IsWebSocketRequest)
        {
            var backend = new Uri($"{(secure ? "wss" : "ws")}://{host}{subPath}{query}");
            await ProxyWebSocketAsync(ctx, backend);
            return;
        }

        var httpBackend = new Uri($"{(secure ? "https" : "http")}://{host}{subPath}{query}");
        await ProxyHttpAsync(ctx, httpBackend);
    }

    private static async Task ProxyWebSocketAsync(HttpContext ctx, Uri backend)
    {
        using var front = await ctx.WebSockets.AcceptWebSocketAsync();
        using var back = new ClientWebSocket();
        foreach (var proto in ctx.WebSockets.WebSocketRequestedProtocols)
            back.Options.AddSubProtocol(proto);

        // LiveKit's mobile SDKs (Flutter/Swift/Kotlin) authenticate the signal socket with an
        // `Authorization: Bearer <LiveKit JWT>` header; only the web SDK uses ?access_token. Without
        // this the header is dropped on the upgrade, LiveKit sees no credentials, and the join fails
        // with 401 "no permissions to access the room". This is LiveKit's own JWT — not an Outcome
        // session token — which is why the HTTP path below still strips Authorization.
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (!string.IsNullOrEmpty(auth))
            back.Options.SetRequestHeader("Authorization", auth);

        try { await back.ConnectAsync(backend, ctx.RequestAborted); }
        catch
        {
            try { await front.CloseAsync(WebSocketCloseStatus.EndpointUnavailable, "backend unavailable", CancellationToken.None); } catch { }
            return;
        }

        var toBackend = PumpAsync(front, back, ctx.RequestAborted);
        var toFrontend = PumpAsync(back, front, ctx.RequestAborted);
        await Task.WhenAny(toBackend, toFrontend);

        try { await front.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        try { await back.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
    }

    private static async Task PumpAsync(WebSocket src, WebSocket dst, CancellationToken ct)
    {
        var buffer = new byte[16384];
        try
        {
            while (src.State == WebSocketState.Open)
            {
                var result = await src.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close) break;
                await dst.SendAsync(new ArraySegment<byte>(buffer, 0, result.Count), result.MessageType, result.EndOfMessage, ct);
            }
        }
        catch { /* one side closed */ }
    }

    private static async Task ProxyHttpAsync(HttpContext ctx, Uri backend)
    {
        using var req = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), backend);
        if (HttpMethods.IsPost(ctx.Request.Method) || HttpMethods.IsPut(ctx.Request.Method) || HttpMethods.IsPatch(ctx.Request.Method))
            req.Content = new StreamContent(ctx.Request.Body);
        foreach (var header in ctx.Request.Headers)
        {
            // Never forward the Outcome bearer token to the LiveKit process — LiveKit auth is
            // the LiveKit JWT (query param), and leaking our session token to another surface
            // is a credential-exposure risk. Hop-by-hop headers must not be forwarded either.
            if (header.Key.StartsWith("Host", StringComparison.OrdinalIgnoreCase)
                || header.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                || header.Key.Equals("Cookie", StringComparison.OrdinalIgnoreCase)
                || header.Key.Equals("Connection", StringComparison.OrdinalIgnoreCase)
                || header.Key.Equals("Keep-Alive", StringComparison.OrdinalIgnoreCase)
                || header.Key.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase))
                continue;
            req.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
        }

        try
        {
            using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);
            ctx.Response.StatusCode = (int)resp.StatusCode;
            foreach (var h in resp.Headers) ctx.Response.Headers[h.Key] = h.Value.ToArray();
            foreach (var h in resp.Content.Headers) ctx.Response.Headers[h.Key] = h.Value.ToArray();
            ctx.Response.Headers.Remove("transfer-encoding");
            await resp.Content.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
        }
        catch
        {
            if (!ctx.Response.HasStarted) ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
        }
    }
}
