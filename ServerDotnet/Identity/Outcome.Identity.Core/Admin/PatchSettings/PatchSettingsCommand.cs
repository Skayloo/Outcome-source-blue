using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

public sealed record PatchSettingsCommand(IReadOnlyDictionary<string, string> Settings, long Permissions)
    : ICommand<IReadOnlyDictionary<string, string>>;
