using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Invites;

public sealed record RevokeInviteCommand(string Code, long ActorPermissions, long ServerId) : ICommand;
