using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediatR;
using Microsoft.Extensions.Options;
using Outcome.Api.Jwt;
using Outcome.Application.Auth;
using Outcome.Domain.Errors;
using Outcome.Infrastructure.Configuration;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Endpoints;

/// <summary>
/// SSO via external OAuth providers (Google, Yandex) — one server-side authorization-code
/// flow for every client. The browser (or the phone's system browser) walks provider auth
/// on our /start URL; the /callback exchanges the code, resolves the profile, signs the
/// user in (creating the account on first visit) and hands the session token back:
///   web → {origin}/#sso=TOKEN (fragment: never hits proxy/server logs)
///   app → outcome://sso?token=TOKEN (deep link the app is listening for)
/// One client id + secret per provider covers web AND mobile.
/// </summary>
public static class OAuthEndpoints
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    private sealed record Flow(string Target); // "web" | "app"

    public static void MapOAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/auth/oauth");

        // Which providers hold keys — clients render exactly these buttons.
        // Per SPACE: CoreOTC may offer Google while the main instance does not, so the
        // buttons come from this tenant's own keys.
        group.MapGet("/providers", async (ISpaceSsoConfig sso, CancellationToken ct) =>
        {
            var list = new List<string>();
            if ((await sso.ProviderAsync("google", ct)).Enabled) list.Add("google");
            if ((await sso.ProviderAsync("yandex", ct)).Enabled) list.Add("yandex");
            return new { providers = list };
        });

        group.MapGet("/{provider}/start", async (string provider, string? target,
            ISpaceSsoConfig sso, IOptions<JwtAuthOptions> jwt, HttpContext ctx, CancellationToken ct) =>
        {
            var (p, cfg) = await ResolveAsync(provider, sso, ct);
            var origin = RequireOrigin(await sso.PublicOriginAsync(ct));
            // Anti-CSRF state: HMAC-signed and self-contained (target + expiry + nonce), so
            // the callback can land on ANY server replica — an in-memory store would lose
            // the flow whenever the LB picks a different instance than /start.
            var (state, nonce) = SignState(jwt.Value.JwtKey, target == "app" ? "app" : "web");
            // The state is self-contained so any replica can verify it — and that is exactly why
            // it alone is not an anti-CSRF token: anyone can fetch one from here and feed it to a
            // victim, who then gets silently signed into the attacker's account. The nonce is
            // echoed into a cookie of THIS browser, and the callback insists the two agree.
            // Lax survives the provider's top-level redirect back to us and nothing else.
            ctx.Response.Cookies.Append("oauth_nonce", nonce, new CookieOptions
            {
                HttpOnly = true,
                Secure = ctx.Request.IsHttps || ctx.Request.Headers["X-Forwarded-Proto"] == "https",
                SameSite = SameSiteMode.Lax,
                Path = "/api/v1/auth/oauth",
                MaxAge = TimeSpan.FromMinutes(10),
            });
            var redirect = $"{origin}/api/v1/auth/oauth/{p}/callback";
            var url = p switch
            {
                "google" => "https://accounts.google.com/o/oauth2/v2/auth" +
                            $"?client_id={Uri.EscapeDataString(cfg.ClientId)}" +
                            $"&redirect_uri={Uri.EscapeDataString(redirect)}" +
                            "&response_type=code&scope=openid%20email%20profile" +
                            $"&state={state}",
                "yandex" => "https://oauth.yandex.ru/authorize" +
                            $"?client_id={Uri.EscapeDataString(cfg.ClientId)}" +
                            $"&redirect_uri={Uri.EscapeDataString(redirect)}" +
                            "&response_type=code" +
                            $"&state={state}",
                _ => throw DomainException.InvalidInput("unknown provider"),
            };
            return Results.Redirect(url);
        });

        group.MapGet("/{provider}/callback", async (string provider, string? code, string? state, string? error,
            ISpaceSsoConfig sso, IOptions<JwtAuthOptions> jwt, ISender mediator, HttpContext ctx, CancellationToken ct) =>
        {
            var (p, cfg) = await ResolveAsync(provider, sso, ct);
            var origin = RequireOrigin(await sso.PublicOriginAsync(ct));
            var verified = state is null ? null : VerifyState(jwt.Value.JwtKey, state);
            var browserNonce = ctx.Request.Cookies["oauth_nonce"];
            ctx.Response.Cookies.Delete("oauth_nonce", new CookieOptions { Path = "/api/v1/auth/oauth" });
            if (verified is null || string.IsNullOrEmpty(browserNonce)
                || !CryptographicOperations.FixedTimeEquals(
                        Encoding.ASCII.GetBytes(browserNonce), Encoding.ASCII.GetBytes(verified.Value.Nonce)))
                return Results.Redirect($"{origin}/#sso_error=state");
            var targetKind = verified.Value.Target;
            var flow = new Flow(targetKind);
            if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(code))
                return Fail(origin, flow, "provider_denied");

            string email, name;
            try
            {
                (email, name) = p == "google"
                    ? await GoogleProfileAsync(cfg, code, $"{origin}/api/v1/auth/oauth/google/callback")
                    : await YandexProfileAsync(cfg, code);
            }
            catch
            {
                return Fail(origin, flow, "exchange_failed");
            }

            // A space may admit only its own company's mailboxes (e.g. CoreOTC: w3g.group).
            // Checked here, before any account is created or matched.
            if (!SpaceSsoConfig.EmailAllowed(email, await sso.AllowedEmailDomainsAsync(ct)))
                return Fail(origin, flow, "email_domain_not_allowed");

            try
            {
                var res = await mediator.Send(new OAuthLoginCommand(p, email, name, ClientIp(ctx)));
                var token = Uri.EscapeDataString(res.Token ?? "");
                return flow.Target == "app"
                    ? AppHandoff($"outcome://sso?token={token}")
                    : Results.Redirect($"{origin}/#sso={token}");
            }
            catch (DomainException ex)
            {
                return Fail(origin, flow, ex.Code.ToLowerInvariant());
            }
        });
    }

    private static IResult Fail(string origin, Flow flow, string reason) =>
        flow.Target == "app"
            ? AppHandoff($"outcome://sso?error={Uri.EscapeDataString(reason)}")
            : Results.Redirect($"{origin}/#sso_error={Uri.EscapeDataString(reason)}");

    /// <summary>
    /// Hands the app its deep link from a REAL page instead of a 302.
    ///
    /// Redirecting straight to outcome:// gives the browser a URL it cannot render itself: the
    /// OS launches the app, and the tab is left with no document at all, spinning forever. The
    /// person has signed in successfully and is looking at a page that looks broken.
    ///
    /// So: a document that fires the deep link from script, offers a plain link for anyone with
    /// script disabled, and says the tab can be closed. window.close() is attempted but
    /// deliberately not promised in the text — a browser only lets a page close a window that a
    /// script opened, and this one was opened by the app.
    /// </summary>
    private static IResult AppHandoff(string deepLink)
    {
        var href = System.Net.WebUtility.HtmlEncode(deepLink);
        var js = System.Text.Json.JsonSerializer.Serialize(deepLink);
        var html =
            "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<meta name=\"robots\" content=\"noindex\"><title>Outcome</title><style>" +
            "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
            "background:#0b0910;color:#e8e4f0;font:16px/1.6 \"Segoe UI\",system-ui,sans-serif;" +
            "text-align:center;padding:2rem}" +
            "h1{font-size:1.4rem;margin:0 0 .6rem}p{color:#a49db4;margin:0 0 1.4rem}" +
            "a{display:inline-block;padding:.8rem 1.5rem;border-radius:.7rem;background:#8b5cf6;" +
            "color:#fff;text-decoration:none;font-weight:600}</style></head><body><div>" +
            "<h1>Готово — возвращайтесь в приложение</h1>" +
            "<p>Эту вкладку можно закрыть.</p>" +
            "<a href=\"" + href + "\">Открыть Outcome</a></div><script>" +
            "location.replace(" + js + ");" +
            "setTimeout(function(){window.close();},1200);" +
            "</script></body></html>";
        return Results.Content(html, "text/html; charset=utf-8");
    }

    private static async Task<(string, OAuthProviderOptions)> ResolveAsync(string provider, ISpaceSsoConfig sso, CancellationToken ct)
    {
        var p = provider.ToLowerInvariant();
        if (p is not ("google" or "yandex")) throw DomainException.InvalidInput("unknown provider");
        var cfg = await sso.ProviderAsync(p, ct);
        if (!cfg.Enabled) throw DomainException.InvalidInput($"{p} sign-in is not configured for this space");
        return (p, cfg);
    }

    private static string RequireOrigin(string publicOrigin)
    {
        var origin = publicOrigin.TrimEnd('/');
        if (origin.Length == 0)
            throw DomainException.Server("OAuth:PublicOrigin is not configured");
        return origin;
    }

    /// <summary>Exchange the code and read the identity from Google's id_token. The token
    /// travels to us straight from Google over TLS, so no signature check is needed —
    /// but audience and issuer are still asserted.</summary>
    private static async Task<(string Email, string Name)> GoogleProfileAsync(
        OAuthProviderOptions cfg, string code, string redirectUri)
    {
        using var resp = await Http.PostAsync("https://oauth2.googleapis.com/token",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["code"] = code,
                ["client_id"] = cfg.ClientId,
                ["client_secret"] = cfg.ClientSecret,
                ["redirect_uri"] = redirectUri,
                ["grant_type"] = "authorization_code",
            }));
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var idToken = doc.RootElement.GetProperty("id_token").GetString()
                      ?? throw new InvalidOperationException("no id_token");

        var parts = idToken.Split('.');
        if (parts.Length != 3) throw new InvalidOperationException("malformed id_token");
        var payloadJson = Convert.FromBase64String(PadBase64(parts[1]));
        using var payload = JsonDocument.Parse(payloadJson);
        var root = payload.RootElement;
        var aud = root.GetProperty("aud").GetString();
        var iss = root.GetProperty("iss").GetString();
        if (aud != cfg.ClientId || (iss != "https://accounts.google.com" && iss != "accounts.google.com"))
            throw new InvalidOperationException("id_token aud/iss mismatch");
        var email = root.GetProperty("email").GetString() ?? "";
        var name = root.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
        return (email, name);
    }

    private static async Task<(string Email, string Name)> YandexProfileAsync(
        OAuthProviderOptions cfg, string code)
    {
        using var resp = await Http.PostAsync("https://oauth.yandex.ru/token",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = code,
                ["client_id"] = cfg.ClientId,
                ["client_secret"] = cfg.ClientSecret,
            }));
        resp.EnsureSuccessStatusCode();
        using var tok = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var access = tok.RootElement.GetProperty("access_token").GetString()
                     ?? throw new InvalidOperationException("no access_token");

        using var req = new HttpRequestMessage(HttpMethod.Get, "https://login.yandex.ru/info?format=json");
        req.Headers.TryAddWithoutValidation("Authorization", "OAuth " + access);
        using var info = await Http.SendAsync(req);
        info.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await info.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        var email = root.TryGetProperty("default_email", out var e) ? e.GetString() ?? "" : "";
        var name = root.TryGetProperty("real_name", out var rn) && rn.GetString() is { Length: > 0 } real
            ? real
            : root.TryGetProperty("login", out var l) ? l.GetString() ?? "" : "";
        return (email, name);
    }

    private static string PadBase64(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=');
    }

    // ── Stateless anti-CSRF state: base64url("target|expiresUnix|nonce") + "." + HMAC ──

    private static (string State, string Nonce) SignState(string key, string target)
    {
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
        var payload = $"{target}|{DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds()}|{nonce}";
        var body = Convert.ToBase64String(Encoding.UTF8.GetBytes(payload))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        return (body + "." + Hmac(key, body), nonce);
    }

    /// <summary>Returns the flow target ("web"/"app") and the nonce the browser must echo back,
    /// or null when the state is forged or expired.</summary>
    private static (string Target, string Nonce)? VerifyState(string key, string state)
    {
        var dot = state.IndexOf('.');
        if (dot <= 0) return null;
        var body = state[..dot];
        var mac = state[(dot + 1)..];
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(Hmac(key, body)), Encoding.ASCII.GetBytes(mac)))
            return null;
        try
        {
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(PadBase64(body))).Split('|');
            if (parts.Length != 3) return null;
            if (!long.TryParse(parts[1], out var exp) ||
                DateTimeOffset.FromUnixTimeSeconds(exp) < DateTimeOffset.UtcNow) return null;
            return parts[0] is "app" or "web" ? (parts[0], parts[2]) : null;
        }
        catch
        {
            return null;
        }
    }

    private static string Hmac(string key, string data)
    {
        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(key));
        return Convert.ToHexString(h.ComputeHash(Encoding.UTF8.GetBytes(data)));
    }

    private static string ClientIp(HttpContext ctx) =>
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}
