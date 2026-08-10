using Newtonsoft.Json;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Application.Uploads;

/// <summary>Persists an unlinked attachment record (message_id is set later when a message is sent).</summary>
public sealed record CreateAttachmentCommand(
    string Id, string Filename, string StoredAs, string Mime, long Size, int? Width, int? Height,
    int? DurationMs = null, string? Waveform = null) : ICommand;
