using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Channels;

// ── mute / unmute notifications for a chat (per-user, any channel type) ──────
public sealed record SetChannelMuteCommand(long ChannelId, long UserId, bool Muted) : ICommand;
