using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Notifications;

/// <summary>
/// RuStore's push gateway (vkpns). One POST per device, authorised by a service token that does
/// not expire on a timer the way the APNs JWT does — so unlike <see cref="ApnsPushSender"/>
/// there is nothing to refresh here.
///
/// The request shape deliberately mirrors FCM v1 (<c>message.token</c>, <c>message.notification</c>,
/// <c>message.data</c>), which is convenient but also a trap: <c>data</c> values must be STRINGS.
/// A number goes out as a number, the gateway rejects the whole message, and the failure looks
/// like a dead token rather than a typo.
/// </summary>
public sealed class RuStorePushSender : IPushSender, IDisposable
{
    private readonly RuStorePushOptions _o;
    private readonly ILogger<RuStorePushSender> _log;
    private readonly HttpClient _http;

    public bool Enabled => _o.ServiceToken.Length > 0 && _o.ProjectId.Length > 0;

    public IReadOnlySet<string> Transports { get; } = new HashSet<string> { PushTarget.RuStore };

    public RuStorePushSender(IOptions<RuStorePushOptions> options, ILogger<RuStorePushSender> log)
    {
        _o = options.Value;
        _log = log;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        if (Enabled)
            _log.LogInformation("RuStore push ready (project {ProjectId})", _o.ProjectId);
        else
            _log.LogInformation("RuStore push not configured — that transport is off");
    }

    public Task<PushOutcome> SendAsync(PushTarget target, PushMessage message, CancellationToken ct = default)
    {
        if (!Enabled) return Task.FromResult(PushOutcome.Failed);

        // Every value here is a string on purpose — see the class comment. The recipient id
        // travels because a phone may hold two accounts, and only one of them can open the
        // envelope below.
        var data = new JsonObject
        {
            ["channel_id"] = message.ChannelId.ToString(),
            ["user_id"] = message.RecipientId.ToString(),
        };
        if (message.ImageUrl is { Length: > 0 } image) data["image_url"] = image;
        var body = new JsonObject
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
        };
        return PostAsync(body, ct);
    }

    public Task<PushOutcome> SendCallAsync(PushTarget target, CallPush call, CancellationToken ct = default)
    {
        if (!Enabled) return Task.FromResult(PushOutcome.Failed);

        // No notification block: a call must not arrive as a banner that outlives the ringing.
        // The app is woken and puts its own incoming-call screen up, then takes it down again
        // when `cancelled` arrives for the same call_id.
        var body = new JsonObject
        {
            ["message"] = new JsonObject
            {
                ["token"] = target.Token,
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
        };
        return PostAsync(body, ct);
    }

    private async Task<PushOutcome> PostAsync(JsonObject body, CancellationToken ct)
    {
        var url = $"{_o.BaseUrl.TrimEnd('/')}/v1/projects/{_o.ProjectId}/messages:send";
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _o.ServiceToken);

        HttpResponseMessage res;
        try
        {
            res = await _http.SendAsync(req, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // The gateway being unreachable says nothing about the token.
            _log.LogWarning(ex, "RuStore push transport error");
            return PushOutcome.Failed;
        }

        using (res)
        {
            if (res.IsSuccessStatusCode) return PushOutcome.Sent;

            var text = await res.Content.ReadAsStringAsync(ct);

            // Only 404 retires a token. 400 is TEMPTING — a token the gateway has never heard of
            // answers 400, as a probe against this endpoint confirmed — but a malformed payload
            // answers 400 too, with the same empty body. Treating it as "device gone" would mean
            // one bad deploy silently deleting every Android push token we have, and nobody
            // noticing until the notifications stopped. Leaking a few dead rows is the cheaper
            // mistake; the sweep that removes them can be written once the gateway's real error
            // vocabulary is known from these logs.
            if (res.StatusCode == HttpStatusCode.NotFound) return PushOutcome.Gone;

            _log.LogWarning("RuStore push rejected: {Status} {Body}", (int)res.StatusCode,
                text.Length > 300 ? text[..300] : text);
            return PushOutcome.Failed;
        }
    }

    public void Dispose() => _http.Dispose();
}
