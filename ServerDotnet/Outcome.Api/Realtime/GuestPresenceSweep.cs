using Outcome.Api.Realtime;
using Outcome.Application.Voice;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Realtime;

/// <summary>
/// One-shot startup reconciliation of guest presence. Webhooks keep the registry live from here
/// on, but a guest who was already sitting in a room when THIS process started predates our
/// webhook subscription — without this sweep they'd be invisible in sidebars until they rejoined.
/// Only channels with an active guest link are queried (the only rooms that can hold guests).
/// </summary>
public sealed class GuestPresenceSweep(
    GuestPresence guests,
    IConnectionHub hub,
    IServiceScopeFactory scopeFactory,
    ISpaceRegistry spaces,
    ILogger<GuestPresenceSweep> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        // LiveKit may be booting alongside us (compose starts both at once) — give it a moment,
        // then retry a couple of times rather than racing it once and giving up.
        for (var attempt = 1; attempt <= 3 && !ct.IsCancellationRequested; attempt++)
        {
            await Task.Delay(TimeSpan.FromSeconds(attempt * 5), ct);
            try
            {
                // Every tenant has its own guest links in its own database — sweep them all.
                foreach (var space in await spaces.ListAsync(ct))
                {
                if (!space.Active) continue;
                await using var scope = scopeFactory.CreateAsyncScopeFor(space);
                var links = scope.ServiceProvider.GetRequiredService<IGuestLinkRepository>();
                var rooms = scope.ServiceProvider.GetRequiredService<ILiveKitRoomService>();

                var channelIds = await links.ListActiveChannelIdsAsync(ct);
                var seeded = 0;
                foreach (var channelId in channelIds)
                {
                    foreach (var (identity, name) in await rooms.ListGuestsAsync(channelId, ct))
                    {
                        if (guests.Add(space.Id, channelId, identity, name) is { } id)
                        {
                            seeded++;
                            await hub.BroadcastAsync(space.Id, WsFrames.VoiceState(new VoiceStateDto(
                                channelId, id, string.IsNullOrEmpty(name) ? "Гость" : name,
                                Muted: false, Deafened: false, Speaking: false, Camera: false, Screenshare: false)));
                        }
                    }
                }
                logger.LogInformation("guest presence sweep done for {Space}: {Guests} guest(s) across {Channels} guest-linked channel(s)",
                    space.Slug, seeded, channelIds.Count);
                }
                return;
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "guest presence sweep attempt {Attempt} failed", attempt);
            }
        }
    }
}
