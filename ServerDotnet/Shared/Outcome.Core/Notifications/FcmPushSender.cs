using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Notifications;

/// <summary>
/// Firebase Cloud Messaging over the HTTP v1 API.
///
/// Unlike APNs, which accepts a self-signed JWT directly, Google wants that JWT exchanged for an
/// access token first — so there are two hops, and the second one's token is what expires. It
/// lasts an hour; we refresh a few minutes early rather than discovering the expiry as a 401 in
/// the middle of a notification.
///
/// This transport exists because RuStore's does not cover it: the RuStore console configures
/// only its own gateway, with no field for a Firebase key, so a phone that has Google services
/// but no RuStore is reachable only by talking to FCM ourselves.
/// </summary>
public sealed class FcmPushSender : IPushSender, IDisposable
{
    private const string Scope = "https://www.googleapis.com/auth/firebase.messaging";
    private static readonly TimeSpan TokenLifetime = TimeSpan.FromMinutes(55);

    private readonly ILogger<FcmPushSender> _log;
    private readonly HttpClient _http;
    private readonly RSA? _key;
    private readonly string _clientEmail = "";
    private readonly string _tokenUri = "https://oauth2.googleapis.com/token";
    private readonly string _projectId = "";

    private readonly SemaphoreSlim _tokenLock = new(1, 1);
    private string _accessToken = "";
    private DateTime _accessTokenExpires;

    public bool Enabled => _key is not null;

    public IReadOnlySet<string> Transports { get; } = new HashSet<string> { PushTarget.Fcm };

    public FcmPushSender(IOptions<FcmOptions> options, ILogger<FcmPushSender> log)
    {
        _log = log;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        var json = ReadCredentials(options.Value);
        if (json is null)
        {
            _log.LogInformation("FCM not configured — that transport is off");
            return;
        }
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            _clientEmail = root.GetProperty("client_email").GetString() ?? "";
            _projectId = root.GetProperty("project_id").GetString() ?? "";
            if (root.TryGetProperty("token_uri", out var uri) && uri.GetString() is { Length: > 0 } u)
                _tokenUri = u;

            var pem = root.GetProperty("private_key").GetString() ?? "";
            var rsa = RSA.Create();
            rsa.ImportFromPem(pem);
            _key = rsa;
            _log.LogInformation("FCM ready (project {ProjectId})", _projectId);
        }
        catch (Exception ex)
        {
            // A malformed key is a configuration mistake, not a runtime condition: say so once,
            // loudly, and stay off rather than failing on every notification for the process's life.
            _log.LogError(ex, "FCM credentials could not be read — that transport is off");
        }
    }

    private string? ReadCredentials(FcmOptions o)
    {
        if (o.Credentials.Trim().Length > 0) return o.Credentials;
        if (o.CredentialsPath.Length == 0) return null;
        try
        {
            return File.ReadAllText(o.CredentialsPath);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "FCM credentials file {Path} could not be read", o.CredentialsPath);
            return null;
        }
    }

    public Task<PushOutcome> SendAsync(PushTarget target, PushMessage message, CancellationToken ct = default)
    {
        if (_key is null) return Task.FromResult(PushOutcome.Failed);

        // FCM insists every `data` value is a string. A number is not coerced — the whole message
        // is rejected, and the rejection looks like a bad token rather than a bad payload.
        var data = new JsonObject
        {
            ["channel_id"] = message.ChannelId.ToString(),
            ["user_id"] = message.RecipientId.ToString(),
        };
        if (message.ImageUrl is { Length: > 0 } image) data["image_url"] = image;
        return PostAsync(new JsonObject
        {
            ["message"] = new JsonObject
            {
                ["token"] = target.Token,
                ["notification"] = new JsonObject
                {
                    ["title"] = message.Title,
                    ["body"] = message.Body,
                },
                ["data"] = data,
            },
        }, ct);
    }

    public Task<PushOutcome> SendCallAsync(PushTarget target, CallPush call, CancellationToken ct = default)
    {
        if (_key is null) return Task.FromResult(PushOutcome.Failed);

        // Data-only and high priority: a call must wake the app to put its own ringing screen up,
        // not arrive as a banner that outlives the ring. Without the priority, Doze can hold this
        // until long after the caller gave up.
        return PostAsync(new JsonObject
        {
            ["message"] = new JsonObject
            {
                ["token"] = target.Token,
                ["android"] = new JsonObject { ["priority"] = "high" },
                ["data"] = new JsonObject
                {
                    ["type"] = "call",
                    ["call_id"] = call.CallId,
                    ["caller_id"] = call.CallerId.ToString(),
                    ["caller_name"] = call.CallerName,
                    ["caller_avatar"] = call.CallerAvatar ?? "",
                    ["channel_id"] = call.ChannelId.ToString(),
                    ["cancelled"] = call.Cancelled ? "true" : "false",
                },
            },
        }, ct);
    }

    private async Task<PushOutcome> PostAsync(JsonObject body, CancellationToken ct)
    {
        var access = await AccessTokenAsync(ct);
        if (access is null) return PushOutcome.Failed;

        var url = $"https://fcm.googleapis.com/v1/projects/{_projectId}/messages:send";
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);

        HttpResponseMessage res;
        try
        {
            res = await _http.SendAsync(req, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            _log.LogWarning(ex, "FCM transport error");
            return PushOutcome.Failed;
        }

        using (res)
        {
            if (res.IsSuccessStatusCode) return PushOutcome.Sent;
            var text = await res.Content.ReadAsStringAsync(ct);

            // 404 UNREGISTERED is FCM saying the app is gone from that device — the one case
            // where deleting the row is right. 400 covers both a dead token and a payload we got
            // wrong, and cannot be told apart from here, so it stays: a bad deploy must not wipe
            // every Android registration we have.
            if (res.StatusCode == HttpStatusCode.NotFound) return PushOutcome.Gone;

            _log.LogWarning("FCM rejected: {Status} {Body}", (int)res.StatusCode,
                text.Length > 300 ? text[..300] : text);
            return PushOutcome.Failed;
        }
    }

    /// <summary>The OAuth access token FCM wants, minted from the service account and cached.</summary>
    private async Task<string?> AccessTokenAsync(CancellationToken ct)
    {
        if (_accessToken.Length > 0 && DateTime.UtcNow < _accessTokenExpires) return _accessToken;

        await _tokenLock.WaitAsync(ct);
        try
        {
            // Another caller may have refreshed it while this one waited.
            if (_accessToken.Length > 0 && DateTime.UtcNow < _accessTokenExpires) return _accessToken;

            var assertion = SignedAssertion();
            using var res = await _http.PostAsync(_tokenUri, new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
                ["assertion"] = assertion,
            }), ct);

            var text = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
            {
                _log.LogWarning("FCM token exchange failed: {Status} {Body}", (int)res.StatusCode,
                    text.Length > 300 ? text[..300] : text);
                return null;
            }

            using var doc = JsonDocument.Parse(text);
            _accessToken = doc.RootElement.GetProperty("access_token").GetString() ?? "";
            _accessTokenExpires = DateTime.UtcNow.Add(TokenLifetime);
            return _accessToken.Length > 0 ? _accessToken : null;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "FCM token exchange error");
            return null;
        }
        finally
        {
            _tokenLock.Release();
        }
    }

    private string SignedAssertion()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header = Base64Url("""{"alg":"RS256","typ":"JWT"}"""u8.ToArray());
        var claims = Base64Url(Encoding.UTF8.GetBytes(new JsonObject
        {
            ["iss"] = _clientEmail,
            ["scope"] = Scope,
            ["aud"] = _tokenUri,
            ["iat"] = now,
            ["exp"] = now + 3600,
        }.ToJsonString()));

        var signingInput = $"{header}.{claims}";
        var signature = _key!.SignData(Encoding.UTF8.GetBytes(signingInput), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{signingInput}.{Base64Url(signature)}";
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public void Dispose()
    {
        _http.Dispose();
        _key?.Dispose();
        _tokenLock.Dispose();
    }
}
