using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Media;

public sealed record SoundDto(long Id, string Name, string Filename, int DurationMs, long UploadedBy, DateTime CreatedAt);
