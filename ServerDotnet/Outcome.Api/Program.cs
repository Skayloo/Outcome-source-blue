using System.Text.Json;
using Microsoft.Extensions.Options;
using Scalar.AspNetCore;
using Outcome.Api.Realtime;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Realtime;
using Outcome.Api.Endpoints;
using Outcome.Api.Http;
using Outcome.Api.Jwt;
using Outcome.Api.Middleware;
using Outcome.Api.Security;
using Outcome.Shared.Abstractions;
using Outcome.Shared.Abstractions.Security;
using Outcome.Infrastructure;
using Outcome.Infrastructure.Configuration;
using Outcome.Infrastructure.Migrations;
using Outcome.Infrastructure.Tenancy;
using Outcome.Shared.Abstractions.Persistence;

var builder = WebApplication.CreateBuilder(args);

// Allow large uploads (100 MB) to match the original /uploads limit.
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 100L * 1024 * 1024);

// Live admin log capture: mirror Information+ log records into a ring buffer that the admin
// "Server Logs" view streams over SSE.
var logRing = new Outcome.Api.Logging.LogRingBuffer();
builder.Logging.AddProvider(new Outcome.Api.Logging.RingBufferLoggerProvider(logRing));
builder.Services.AddSingleton(logRing);
builder.Services.AddSingleton<Outcome.Api.Logging.LogTicketStore>();

// Layered config: appsettings + environment variables. OUTCOME_-prefixed vars override
// (e.g. OUTCOME_Server__Name override the matching config key).
builder.Configuration.AddEnvironmentVariables(prefix: "OUTCOME_");

// Feature modules: register each module's MediatR handlers + validators + shared behaviors.
builder.Services.AddApplicationCore(
    typeof(Outcome.Identity.IdentityModule).Assembly,
    typeof(Outcome.Chat.ChatModule).Assembly);
builder.Services.AddInfrastructure(builder.Configuration);

// JWT bearer authentication (Microsoft.AspNetCore.Authentication.JwtBearer) + IJwtTokenService.
builder.Services.AddJwtAuthentication(builder.Configuration);

// Request-scoped authenticated principal, populated by JwtCurrentUserMiddleware.
builder.Services.AddScoped<CurrentUserContext>();
builder.Services.AddScoped<ICurrentUser>(sp => sp.GetRequiredService<CurrentUserContext>());

// Request-scoped active server (tenant), populated by CurrentServerMiddleware.
builder.Services.AddScoped<CurrentServerContext>();
builder.Services.AddScoped<ICurrentServer>(sp => sp.GetRequiredService<CurrentServerContext>());

// ── Replication ──────────────────────────────────────────────────────────────
// With OUTCOME_Redis__Url set, real-time fan-out (WS broadcasts / per-user sends /
// force-close), the reconnect replay buffer + global sequence, 2FA partial challenges,
// and admin log-stream tickets all move to Redis so ANY number of API replicas behaves
// like one server. Without it, everything stays in-process (single-instance mode).
var redisUrl = builder.Configuration["Redis:Url"];
if (!string.IsNullOrWhiteSpace(redisUrl))
{
    var redisOptions = StackExchange.Redis.ConfigurationOptions.Parse(redisUrl);
    redisOptions.AbortOnConnectFail = false; // reconnects in the background if Redis starts later
    var mux = StackExchange.Redis.ConnectionMultiplexer.Connect(redisOptions);
    builder.Services.AddSingleton<StackExchange.Redis.IConnectionMultiplexer>(mux);
    builder.Services.AddSingleton<IConnectionHub, RedisBackplaneRegistry>();
    builder.Services.AddSingleton<IMessageReplayBuffer, RedisReplayBuffer>();
    builder.Services.AddSingleton<IPendingCallStore, RedisPendingCallStore>();
    builder.Services.AddScoped<Outcome.Shared.Abstractions.Security.IPartialAuthStore,
        Outcome.Infrastructure.Security.RedisPartialAuthStore>();
    builder.Services.AddScoped<Outcome.Shared.Abstractions.Security.IPendingRegistrationStore,
        Outcome.Infrastructure.Security.RedisPendingRegistrationStore>();
}
else
{
    builder.Services.AddSingleton<IConnectionHub, ConnectionRegistry>();
    builder.Services.AddSingleton<IMessageReplayBuffer, MessageReplayBuffer>();
    builder.Services.AddSingleton<IPendingCallStore, PendingCallStore>();
}
// Application code keeps injecting IConnectionRegistry and keeps calling it without a
// tenant argument — this scoped view supplies the space, so no handler can forget it.
builder.Services.AddScoped<IConnectionRegistry>(sp => new SpaceScopedConnectionRegistry(
    sp.GetRequiredService<IConnectionHub>(),
    sp.GetRequiredService<Outcome.Infrastructure.Tenancy.ICurrentSpace>().Space.Id));

builder.Services.AddSingleton<PushNotifier>();
builder.Services.AddSingleton<WebSocketHandler>();
builder.Services.AddSingleton<WsConnectionLimiter>();
// Guest presence: webhook-fed registry + a startup sweep so guests predating this process show up.
builder.Services.AddSingleton<GuestPresence>();
builder.Services.AddHostedService<GuestPresenceSweep>();

// Wire JSON must match the original contract consumed by the frontend:
// snake_case property names, ISO-8601 UTC timestamps.
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
    o.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower;
});

// OpenAPI document (served at /openapi/v1.json) for the Scalar API reference UI.
builder.Services.AddOpenApi();

builder.Services.AddCors();

// Validated in every environment, not just Development: with tenancy, a singleton that
// captures a scoped service captures ONE tenant's space and silently serves it to everyone.
// Better to refuse to start than to leak.
builder.Host.UseDefaultServiceProvider(o => { o.ValidateScopes = true; o.ValidateOnBuild = true; });

var app = builder.Build();

// Apply database migrations on startup, waiting for Postgres to accept connections.
await MigrateDatabaseAsync(app);

// ── Real client IP ───────────────────────────────────────────────────────────
// The API sits behind a reverse proxy (Caddy in the compose stack), so RemoteIpAddress is
// the PROXY for every request: per-IP rate limits would throttle the whole site as one
// client, and audit/ban IPs would all be the proxy. Resolve the real address from
// X-Forwarded-For — but ONLY when the peer is a trusted proxy (default: loopback + RFC1918,
// i.e. our own docker network). Trusting the header from arbitrary peers would let an
// attacker forge his IP and sail through rate limits, which is why this is an allowlist
// (the Go server enforced the same rule via trusted_proxies). Override with
// OUTCOME_TrustedProxies (comma-separated CIDRs), e.g. to add Cloudflare's ranges.
var fwd = new ForwardedHeadersOptions
{
    ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor,
    ForwardLimit = null, // walk the whole X-Forwarded-For chain, stopping at the first untrusted hop
};
fwd.KnownNetworks.Clear();
fwd.KnownProxies.Clear();
var trustedProxies = app.Configuration["TrustedProxies"]
    ?? "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
foreach (var cidr in trustedProxies.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
    fwd.KnownNetworks.Add(Microsoft.AspNetCore.HttpOverrides.IPNetwork.Parse(cidr));
app.UseForwardedHeaders(fwd);

app.UseMiddleware<ErrorHandlingMiddleware>();

// Which tenant is this? Everything after this line reads that space's database and nothing
// else, so it runs before auth: a token is only valid inside the space that issued it.
app.UseMiddleware<Outcome.Api.Middleware.SpaceResolutionMiddleware>();

// Any origin may call the API: this instance can be signed into from the web client of
// ANOTHER self-hosted Outcome instance (the login screen's server picker), and auth is a
// Bearer header — no cookies — so cross-origin requests carry no ambient credentials
// a forged page could ride on (CSRF needs cookies; there are none).
app.UseCors(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());

// Baseline security headers on every response. The frontend nginx sets the SPA's CSP;
// here we harden the API/asset responses (nosniff, clickjacking, referrer, powerful-feature
// lockdown) and emit HSTS when the edge served us over TLS (X-Forwarded-Proto=https).
app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["X-Frame-Options"] = "DENY";
    h["Referrer-Policy"] = "strict-origin-when-cross-origin";
    h["Permissions-Policy"] = "geolocation=(), payment=(), usb=(), interest-cohort=()";
    // cross-origin (not same-site): the web client on ANOTHER instance may embed our
    // avatars/attachments after its user signs in here via the login server picker.
    h["Cross-Origin-Resource-Policy"] = "cross-origin";
    if (string.Equals(ctx.Request.Headers["X-Forwarded-Proto"], "https", StringComparison.OrdinalIgnoreCase)
        || ctx.Request.IsHttps)
    {
        h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
    }
    await next();
});

app.UseWebSockets();
app.UseAuthentication();
app.UseMiddleware<JwtCurrentUserMiddleware>();
app.UseMiddleware<CurrentServerMiddleware>();
app.UseDefaultFiles();
app.UseStaticFiles();

var startedAtUtc = DateTimeOffset.UtcNow;
const string version = "0.1.0-dotnet";
// Which build this is: "red" = private (E2EE clients, SaaS features), "blue" = public
// self-hosted. Set by the Dockerfile's OUTCOME_EDITION build arg; defaults to blue so an
// unlabelled build can never claim to be the private one.
var edition = Environment.GetEnvironmentVariable("OUTCOME_EDITION") is "red" ? "red" : "blue";

// All JSON endpoints are grouped under a filter that serializes responses with Newtonsoft.Json.
// OpenAPI spec + Scalar API reference UI — DEV ONLY. Never exposed in production builds
// (ASPNETCORE_ENVIRONMENT=Production), so the deploy/ prod configs don't ship API docs.
// The local dev stack sets ASPNETCORE_ENVIRONMENT=Development to browse it at <origin>/scalar.
if (app.Environment.IsDevelopment())
{
app.MapOpenApi(); // /openapi/v1.json
// Scalar API reference UI at /scalar (reads /openapi/v1.json), proxied through the frontend
// nginx → browse it at <origin>/scalar. Custom "mandarin" theme: a warm tangerine gradient
// with amber accents (overrides Scalar's vars in both light/dark mode + paints the backdrop).
const string mandarinCss = """
:root, .scalar-app, .light-mode, .dark-mode {
  --scalar-color-1: #fff6ec;
  --scalar-color-2: #ffe3c4;
  --scalar-color-3: #ffbe86;
  --scalar-color-accent: #ffb454;
  --scalar-background-1: transparent;
  --scalar-background-2: rgba(26, 13, 6, 0.62);
  --scalar-background-3: rgba(40, 20, 9, 0.62);
  --scalar-background-accent: rgba(255, 180, 84, 0.16);
  --scalar-border-color: rgba(255, 170, 90, 0.22);
  --scalar-sidebar-background-1: rgba(16, 8, 4, 0.55);
  --scalar-sidebar-color-1: #fff6ec;
  --scalar-sidebar-color-2: #ffbe86;
  --scalar-sidebar-border-color: rgba(255, 170, 90, 0.14);
  --scalar-sidebar-item-hover-background: rgba(255, 180, 84, 0.14);
  --scalar-sidebar-item-hover-color: #ffffff;
  --scalar-sidebar-item-active-background: rgba(255, 180, 84, 0.24);
  --scalar-sidebar-color-active: #ffdca6;
  --scalar-sidebar-search-background: rgba(28, 12, 4, 0.5);
  --scalar-sidebar-search-border-color: rgba(255, 170, 90, 0.2);
  --scalar-button-1: #f97316;
  --scalar-button-1-color: #24120a;
  --scalar-button-1-hover: #fb8b3a;
}
.scalar-app {
  /* Dark canvas with a warm orange "spotlight" glowing from the upper-left, fading to a
     near-black burnt brown at the right/bottom edges (matches the CorePay reference). */
  background:
    radial-gradient(115% 105% at 24% 16%,
      #d9691d 0%, #b8530f 22%, #83390e 45%, #431e0a 68%, #1a0d06 88%, #130a05 100%)
    #140a05 fixed !important;
}
""";
app.MapScalarApiReference(options =>
{
    options.Title = "Outcome API";
    options.CustomCss = mandarinCss;
});
}

var api = app.MapGroup("").AddEndpointFilter<NewtonsoftJsonOutputFilter>();

api.MapGet("/health", (IConnectionRegistry reg) => new HealthResponse("ok", version, edition, Uptime(), reg.Count));
api.MapGet("/api/v1/health", (IConnectionRegistry reg) => new HealthResponse("ok", version, edition, Uptime(), reg.Count));
api.MapGet("/api/v1/info", (IOptions<ServerOptions> server) => new InfoResponse(server.Value.Name, version));

api.MapAuthEndpoints();
app.MapSpaceAdminEndpoints();
api.MapOAuthEndpoints();
api.MapUserEndpoints();
api.MapServerEndpoints();
api.MapChannelEndpoints();
api.MapUploadEndpoints();
api.MapRoleEndpoints();
api.MapInviteEndpoints();
api.MapSearchEndpoints();
api.MapDmEndpoints();
api.MapDeviceEndpoints();
api.MapFriendEndpoints();
api.MapBugEndpoints();
api.MapModerationEndpoints();
api.MapGuestEndpoints();
api.MapVoiceEndpoints();
api.MapMediaEndpoints();
api.MapLiveKitEndpoints();
app.Map("/livekit/{**rest}", LiveKitProxy.HandleAsync);
api.MapSetupEndpoints();
api.MapAdminEndpoints();

app.Map("/api/v1/ws", async (HttpContext ctx, WebSocketHandler handler, WsConnectionLimiter wsLimit) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
    // Cap sockets per client IP BEFORE accepting: a single box must not be able to hold
    // thousands of idle sockets (each costs memory + an fd). The default (64) is roomy
    // enough for a whole dorm behind one NAT.
    var clientIp = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    if (!wsLimit.TryEnter(clientIp)) { ctx.Response.StatusCode = StatusCodes.Status429TooManyRequests; return; }
    try
    {
        using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        // The upgrade request already resolved the tenant; the socket keeps it for life.
        var space = ctx.RequestServices.GetRequiredService<Outcome.Infrastructure.Tenancy.ICurrentSpace>().Space;
        await handler.RunAsync(ws, space, ctx.RequestAborted);
    }
    finally { wsLimit.Exit(clientIp); }
});

// Admin live log stream (Server-Sent Events). Mapped on `app` (not the Newtonsoft group) so it can
// write a raw text/event-stream. EventSource can't set headers, so it authenticates via a single-use
// ticket from POST /api/v1/admin/logs/ticket.
app.MapGet("/api/v1/admin/logs/stream", async (HttpContext ctx, Outcome.Api.Logging.LogRingBuffer ring, Outcome.Api.Logging.LogTicketStore tickets) =>
{
    if (!tickets.Consume(ctx.Request.Query["ticket"].ToString()))
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }
    ctx.Response.Headers.ContentType = "text/event-stream";
    ctx.Response.Headers.CacheControl = "no-cache";
    ctx.Response.Headers["X-Accel-Buffering"] = "no";

    var channel = System.Threading.Channels.Channel.CreateBounded<Outcome.Api.Logging.LogEntry>(
        new System.Threading.Channels.BoundedChannelOptions(2000)
        {
            FullMode = System.Threading.Channels.BoundedChannelFullMode.DropOldest,
        });
    void OnLog(Outcome.Api.Logging.LogEntry e) => channel.Writer.TryWrite(e);

    async Task WriteAsync(Outcome.Api.Logging.LogEntry e)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(new
        {
            ts = e.Timestamp, level = e.Level, source = e.Category, msg = e.Message,
        });
        await ctx.Response.WriteAsync($"data: {json}\n\n", ctx.RequestAborted);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
    }

    foreach (var e in ring.Snapshot()) await WriteAsync(e);
    ring.Subscribe(OnLog);
    try
    {
        await foreach (var e in channel.Reader.ReadAllAsync(ctx.RequestAborted))
            await WriteAsync(e);
    }
    catch (OperationCanceledException) { /* client disconnected */ }
    finally { ring.Unsubscribe(OnLog); }
});

// SPA fallback — serve index.html for client-side routes (web build lands in wwwroot).
app.MapFallbackToFile("index.html");

app.Run();
return;

long Uptime() => (long)(DateTimeOffset.UtcNow - startedAtUtc).TotalSeconds;

static async Task MigrateDatabaseAsync(WebApplication app)
{
    var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup");
    var registry = app.Services.GetRequiredService<SpaceRegistry>();
    var provisioner = app.Services.GetRequiredService<Outcome.Infrastructure.Tenancy.SpaceProvisioner>();
    const int maxAttempts = 30;
    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        try
        {
            // The control table lives in the root database; every space (root included) then
            // gets its own database created and migrated. A tenant added while this instance
            // was down is picked up here.
            await registry.EnsureSchemaAsync();
            await provisioner.ProvisionAllAsync();
            await ResetPresenceAsync(app, logger);
            return;
        }
        catch (Exception ex) when (attempt < maxAttempts)
        {
            logger.LogWarning("Database not ready (attempt {Attempt}/{Max}): {Message}", attempt, maxAttempts, ex.Message);
            await Task.Delay(TimeSpan.FromSeconds(2));
        }
    }
}

/// <summary>Clears stale "online" rows left by a process that died without running its
/// disconnect handler — a deploy, a crash, an OOM kill. A freshly started instance holds no
/// connections, so anything still marked online is a leftover by definition.
///
/// ponytail: correct while this runs as a single instance (compose's `deploy.replicas` is a
/// Swarm directive and is ignored by `docker compose up`, so there is exactly one). Run two
/// for real and a restart of one would wrongly clear the other's users; presence would then
/// need to live in Redis with a heartbeat TTL rather than in a column.
static async Task ResetPresenceAsync(WebApplication app, ILogger logger)
{
    var registry = app.Services.GetRequiredService<SpaceRegistry>();
    var scopes = app.Services.GetRequiredService<IServiceScopeFactory>();
    foreach (var space in await registry.ListAsync())
    {
        if (!space.Active) continue;
        try
        {
            await using var scope = scopes.CreateAsyncScopeFor(space);
            var cleared = await scope.ServiceProvider.GetRequiredService<IUserRepository>().ResetPresenceAsync();
            if (cleared > 0)
                logger.LogInformation("Space {Slug}: cleared {Count} stale online status(es)", space.Slug, cleared);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Space {Slug}: could not reset presence", space.Slug);
        }
    }
}

internal sealed record HealthResponse(string Status, string Version, string Edition, long Uptime, int OnlineUsers);
internal sealed record InfoResponse(string Name, string Version);
