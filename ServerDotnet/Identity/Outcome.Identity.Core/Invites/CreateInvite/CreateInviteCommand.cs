using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Invites;

/// <summary><paramref name="ServerId"/> is set only by the admin console (the space's Administrator
/// picks any server); everyone else gets an invite to the server their request resolved to.</summary>
public sealed record CreateInviteCommand(int MaxUses, int ExpiresInHours, long ActorUserId, long ActorPermissions, long? ServerId = null)
    : ICommand<InviteDto>;
