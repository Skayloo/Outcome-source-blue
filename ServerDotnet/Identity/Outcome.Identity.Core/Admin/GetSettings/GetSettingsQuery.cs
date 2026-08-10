using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

// ── settings ─────────────────────────────────────────────────────────────────
public sealed record GetSettingsQuery(long Permissions) : IQuery<IReadOnlyDictionary<string, string>>;
