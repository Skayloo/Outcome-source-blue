using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

using Outcome.Application.Common;

namespace Outcome.Application.Invites;

public sealed record ListInvitesQuery(long ActorPermissions, long ServerId, int Limit = int.MaxValue, int Offset = 0) : IQuery<Paged<InviteDto>>;
