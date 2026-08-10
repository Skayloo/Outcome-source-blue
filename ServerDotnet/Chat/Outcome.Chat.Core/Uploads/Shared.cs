using Newtonsoft.Json;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Application.Uploads;

/// <summary>Response for POST /api/v1/uploads. width/height omitted when null.</summary>
public sealed record UploadResultDto(
    string Id,
    string Filename,
    long Size,
    string Mime,
    string Url,
    [property: JsonProperty(NullValueHandling = NullValueHandling.Ignore)] int? Width,
    [property: JsonProperty(NullValueHandling = NullValueHandling.Ignore)] int? Height,
    [property: JsonProperty("duration_ms", NullValueHandling = NullValueHandling.Ignore)] int? DurationMs = null,
    [property: JsonProperty("waveform", NullValueHandling = NullValueHandling.Ignore)] string? Waveform = null);
