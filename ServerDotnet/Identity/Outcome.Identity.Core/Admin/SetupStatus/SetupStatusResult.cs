using System.Security.Cryptography;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

/// <summary>Public pre-auth flags the connect screen needs BEFORE any account exists:
/// whether the owner-setup wizard should run, and whether registration demands an invite
/// (so the form can mark the invite field required instead of failing on submit).</summary>
public sealed record SetupStatusResult(bool NeedsSetup, bool InviteRequired);
