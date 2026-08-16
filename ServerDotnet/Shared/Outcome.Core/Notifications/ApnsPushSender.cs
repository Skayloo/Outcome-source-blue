using System.Net;
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
/// APNs over HTTP/2 with token-based (.p8) auth. No SDK: the whole protocol is one POST per
/// device with a JWT Apple lets us reuse for an hour.
///
/// Apple runs two gateways that share credentials but not device tokens — a build signed with
/// a development profile only exists in the sandbox one. The app cannot tell us reliably which
/// it is, so we assume production and let the first rejection teach us otherwise.
/// </summary>
public sealed class ApnsPushSender : IPushSender, IDisposable
{
    private const string ProdHost = "api.push.apple.com";
    private const string SandboxHost = "api.sandbox.push.apple.com";
    // Apple rejects tokens older than an hour and refuses ones refreshed more than every 20
    // minutes. Sit in the middle.
    private static readonly TimeSpan JwtLifetime = TimeSpan.FromMinutes(45);

    private readonly ApnsOptions _o;
    private readonly ILogger<ApnsPushSender> _log;
    private readonly HttpClient _http;
    private readonly ECDsa? _key;
    private readonly Lock _jwtLock = new();
    private string _jwt = "";
    private DateTime _jwtIssued;

    public bool Enabled => _key is not null;

    public ApnsPushSender(IOptions<ApnsOptions> options, ILogger<ApnsPushSender> log)
    {
        _o = options.Value;
        _log = log;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        var pem = ReadKey();
        if (pem is null)
        {
            _log.LogInformation("APNs not configured — push notifications are off");
            return;
        }
        if (string.IsNullOrWhiteSpace(_o.KeyId) || string.IsNullOrWhiteSpace(_o.TeamId))
        {
            _log.LogWarning("APNs key present but KeyId/TeamId missing — push notifications are off");
            return;
        }
        try
        {
            var key = ECDsa.Create();
            key.ImportFromPem(pem);
            _key = key;
            _log.LogInformation("APNs ready (team {TeamId}, key {KeyId}, topic {Topic})", _o.TeamId, _o.KeyId, _o.BundleId);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "APNs key could not be read — push notifications are off");
        }
    }

    private string? ReadKey()
    {
        if (!string.IsNullOrWhiteSpace(_o.Key)) return _o.Key.Replace("\\n", "\n");
        if (string.IsNullOrWhiteSpace(_o.KeyPath)) return null;
        try
        {
            return File.ReadAllText(_o.KeyPath);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "APNs key file {Path} could not be read", _o.KeyPath);
            return null;
        }
    }

    public async Task<PushOutcome> SendAsync(string deviceToken, bool sandbox, PushMessage message, CancellationToken ct = default)
    {
        if (_key is null) return PushOutcome.Failed;

        var aps = new JsonObject
        {
            ["alert"] = new JsonObject { ["title"] = message.Title, ["body"] = message.Body },
            ["sound"] = "default",
            // Groups the chat's notifications together in Notification Center.
            ["thread-id"] = message.ChannelId.ToString(),
        };

        var payload = new JsonObject
        {
            ["aps"] = aps,
            // Read by the app when the user taps it, to open the right chat.
            ["channel_id"] = message.ChannelId,
            ["user_id"] = message.RecipientId,
        };

        if (message.ImageUrl is { Length: > 0 } image)
        {
            // Same flag as the encrypted case, for a different reason: only the extension can
            // fetch the picture and hang it on the banner. Without it iOS shows the text alone.
            aps["mutable-content"] = 1;
            payload["image_url"] = image;
        }

        var json = payload.ToJsonString();
        var (status, reason) = await PostAsync(sandbox ? SandboxHost : ProdHost, deviceToken, json, ct);

        // A production "unknown device" is what a development build looks like from here.
        if (status == HttpStatusCode.BadRequest && reason == "BadDeviceToken" && !sandbox)
        {
            var (sbStatus, sbReason) = await PostAsync(SandboxHost, deviceToken, json, ct);
            if (sbStatus == HttpStatusCode.OK) return PushOutcome.Sandbox;
            return sbStatus is HttpStatusCode.Gone || sbReason == "BadDeviceToken" ? PushOutcome.Gone : PushOutcome.Failed;
        }

        return status switch
        {
            HttpStatusCode.OK => PushOutcome.Sent,
            // 410 Unregistered: the app was deleted. 400 BadDeviceToken on the gateway we
            // already know is right: the token is garbage. Either way it will never work again.
            HttpStatusCode.Gone => PushOutcome.Gone,
            HttpStatusCode.BadRequest when reason == "BadDeviceToken" => PushOutcome.Gone,
            _ => PushOutcome.Failed,
        };
    }

    public async Task<PushOutcome> SendCallAsync(string voipToken, bool sandbox, CallPush call, CancellationToken ct = default)
    {
        if (_key is null) return PushOutcome.Failed;

        // No "aps" block: a VoIP push draws nothing by itself. It wakes the app, which is then
        // obliged to put the system call screen up — that is Apple's bargain for this privilege.
        var payload = new JsonObject
        {
            ["call_id"] = call.CallId,
            ["caller_id"] = call.CallerId,
            ["caller_name"] = call.CallerName,
            ["caller_avatar"] = call.CallerAvatar,
            ["channel_id"] = call.ChannelId,
            ["cancelled"] = call.Cancelled,
        }.ToJsonString();

        var (status, reason) = await PostAsync(sandbox ? SandboxHost : ProdHost, voipToken, payload, ct, voip: true);

        if (status == HttpStatusCode.BadRequest && reason == "BadDeviceToken" && !sandbox)
        {
            var (sbStatus, sbReason) = await PostAsync(SandboxHost, voipToken, payload, ct, voip: true);
            if (sbStatus == HttpStatusCode.OK) return PushOutcome.Sandbox;
            return sbStatus is HttpStatusCode.Gone || sbReason == "BadDeviceToken" ? PushOutcome.Gone : PushOutcome.Failed;
        }

        return status switch
        {
            HttpStatusCode.OK => PushOutcome.Sent,
            HttpStatusCode.Gone => PushOutcome.Gone,
            HttpStatusCode.BadRequest when reason == "BadDeviceToken" => PushOutcome.Gone,
            _ => PushOutcome.Failed,
        };
    }

    private async Task<(HttpStatusCode Status, string? Reason)> PostAsync(string host, string deviceToken, string payload,
        CancellationToken ct, bool voip = false)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"https://{host}/3/device/{deviceToken}")
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
                // Per REQUEST, not on the client: HttpClient.DefaultRequestVersion does not
                // reach a hand-built HttpRequestMessage, and APNs answers HTTP/1.1 by hanging up.
                Version = HttpVersion.Version20,
                VersionPolicy = HttpVersionPolicy.RequestVersionExact,
            };
            req.Headers.TryAddWithoutValidation("authorization", "bearer " + Jwt());
            // A VoIP push is addressed to a different topic — the same bundle id with ".voip" —
            // and Apple rejects it outright if the type header disagrees.
            req.Headers.TryAddWithoutValidation("apns-topic", voip ? _o.BundleId + ".voip" : _o.BundleId);
            req.Headers.TryAddWithoutValidation("apns-push-type", voip ? "voip" : "alert");
            req.Headers.TryAddWithoutValidation("apns-priority", "10");

            using var res = await _http.SendAsync(req, ct);
            if (res.IsSuccessStatusCode) return (HttpStatusCode.OK, null);

            var text = await res.Content.ReadAsStringAsync(ct);
            string? reason = null;
            try
            {
                reason = JsonDocument.Parse(text).RootElement.TryGetProperty("reason", out var r) ? r.GetString() : null;
            }
            catch (JsonException) { /* Apple always sends JSON here, but never trust that */ }

            // A dead token is routine (app deleted); a config error is not — say which.
            if (res.StatusCode is HttpStatusCode.Gone || reason == "BadDeviceToken")
                _log.LogDebug("APNs rejected a device token ({Reason})", reason);
            else
                _log.LogWarning("APNs {Status}: {Reason} ({Body})", (int)res.StatusCode, reason, text);

            return (res.StatusCode, reason);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "APNs request to {Host} failed", host);
            return (HttpStatusCode.ServiceUnavailable, null);
        }
    }

    /// <summary>The provider token, minted on demand and reused until Apple would reject it.</summary>
    private string Jwt()
    {
        lock (_jwtLock)
        {
            if (_jwt.Length > 0 && DateTime.UtcNow - _jwtIssued < JwtLifetime) return _jwt;

            var header = B64(Encoding.UTF8.GetBytes($$"""{"alg":"ES256","kid":"{{_o.KeyId}}"}"""));
            var issued = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var claims = B64(Encoding.UTF8.GetBytes($$"""{"iss":"{{_o.TeamId}}","iat":{{issued}}}"""));
            var signing = Encoding.ASCII.GetBytes($"{header}.{claims}");
            // SignData returns the raw r‖s pair, which is exactly the ES256 JWS signature
            // format (the DER encoding ASN.1 would give us is not).
            var sig = B64(_key!.SignData(signing, HashAlgorithmName.SHA256));

            _jwt = $"{header}.{claims}.{sig}";
            _jwtIssued = DateTime.UtcNow;
            return _jwt;
        }
    }

    private static string B64(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public void Dispose()
    {
        _key?.Dispose();
        _http.Dispose();
    }
}
