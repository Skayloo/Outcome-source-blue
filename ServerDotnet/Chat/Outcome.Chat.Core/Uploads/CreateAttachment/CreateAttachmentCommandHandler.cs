using Newtonsoft.Json;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Application.Uploads;

public sealed class CreateAttachmentHandler(IAttachmentRepository attachments)
    : IRequestHandler<CreateAttachmentCommand>
{
    public Task Handle(CreateAttachmentCommand c, CancellationToken ct) =>
        attachments.CreateAsync(new Attachment
        {
            Id = c.Id,
            MessageId = null,
            Filename = c.Filename,
            StoredAs = c.StoredAs,
            MimeType = c.Mime,
            Size = c.Size,
            Width = c.Width,
            Height = c.Height,
            DurationMs = c.DurationMs,
            Waveform = c.Waveform,
        }, ct);
}
