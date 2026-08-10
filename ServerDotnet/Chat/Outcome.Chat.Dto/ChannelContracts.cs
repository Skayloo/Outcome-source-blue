using Newtonsoft.Json;
using Outcome.Domain.Entities;

namespace Outcome.Application.Channels;

/// <summary>Channel wire shape (snake_case). voice_quality/mixing_threshold omitted when null.</summary>
public sealed record ChannelDto(
    long Id,
    string Name,
    string Type,
    string Category,
    string Topic,
    int Position,
    int SlowMode,
    bool Archived,
    DateTime CreatedAt,
    int VoiceMaxUsers,
    [property: JsonProperty(NullValueHandling = NullValueHandling.Ignore)] string? VoiceQuality,
    [property: JsonProperty(NullValueHandling = NullValueHandling.Ignore)] int? MixingThreshold,
    int VoiceMaxVideo);

public static class ChannelMapper
{
    public static ChannelDto ToDto(Channel c) => new(
        c.Id, c.Name, c.Type, c.Category ?? string.Empty, c.Topic ?? string.Empty,
        c.Position, c.SlowMode, c.Archived, c.CreatedAt, c.VoiceMaxUsers,
        c.VoiceQuality, c.MixingThreshold, c.VoiceMaxVideo);
}
