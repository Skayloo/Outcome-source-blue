using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Realtime;

/// <summary>
/// Persists a message sent over the WebSocket. Authorization context (user id, role,
/// permissions) is captured at connection time and passed in explicitly (no HTTP scope).
/// </summary>
public sealed record CreateMessageCommand(
    long ChannelId, string Content, long? ReplyTo, long UserId, long Permissions, long RoleId,
    long ServerId, IReadOnlyList<string> Attachments, string? ForwardedFrom = null)
    : ICommand<CreatedMessage>;
