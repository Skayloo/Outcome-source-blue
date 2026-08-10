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

public sealed class SetupStatusHandler(IUserRepository users, ISettingsRepository settings)
    : IRequestHandler<SetupStatusQuery, SetupStatusResult>
{
    public async Task<SetupStatusResult> Handle(SetupStatusQuery request, CancellationToken ct) =>
        new(await users.CountAsync(ct) == 0,
            AuthRules.ParseBoolean(await settings.GetAsync("registration_invite_only", ct), false));
}
