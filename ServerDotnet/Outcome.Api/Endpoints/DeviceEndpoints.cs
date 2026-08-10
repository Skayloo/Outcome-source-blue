using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

/// <summary>
/// Push destinations. The app posts its APNs token after login and deletes it on sign-out —
/// otherwise the next person to use the phone would keep getting the previous owner's alerts.
/// </summary>
public static class DeviceEndpoints
{
    public sealed record RegisterDeviceBody(string Token, string? Platform, string? Kind);

    // A hex APNs token is 64 chars today; leave room without accepting arbitrary blobs.
    private const int MaxTokenChars = 200;

    public static void MapDeviceEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/devices", async (RegisterDeviceBody body, ICurrentUser current, IDeviceTokenRepository devices) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("authentication required");
            var token = (body.Token ?? "").Trim();
            if (token.Length == 0 || token.Length > MaxTokenChars)
                throw DomainException.BadRequest("device token is missing or too long");

            var platform = body.Platform == "android" ? "android" : "ios";
            // Anything unrecognised is an alert token: pushing a call to it would just be
            // rejected by Apple, whereas the reverse would silently drop message notifications.
            var kind = body.Kind == "voip" ? "voip" : "alert";
            await devices.RegisterAsync(current.UserId, token, platform, kind);
            return Results.NoContent();
        });

        app.MapDelete("/api/v1/devices/{token}", async (string token, ICurrentUser current, IDeviceTokenRepository devices) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("authentication required");
            await devices.RemoveAsync(token, current.UserId);
            return Results.NoContent();
        });
    }
}
