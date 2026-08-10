using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed class GetMyProfileHandler(IUserRepository users, IRoleRepository roles)
    : IRequestHandler<GetMyProfileQuery, MemberProfileDto>
{
    public Task<MemberProfileDto> Handle(GetMyProfileQuery q, CancellationToken ct) =>
        MemberProfile.BuildAsync(users, roles, q.UserId, ct);
}
