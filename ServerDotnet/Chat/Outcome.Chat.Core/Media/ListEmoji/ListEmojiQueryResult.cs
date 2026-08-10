using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Media;

public sealed record EmojiDto(long Id, string Shortcode, string Filename, long UploadedBy, DateTime CreatedAt);
