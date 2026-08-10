using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class GetMeHandler(
    ICurrentUser current,
    IUserRepository users) : IRequestHandler<GetMeQuery, UserDto>
{
    public async Task<UserDto> Handle(GetMeQuery request, CancellationToken ct)
    {
        if (!current.IsAuthenticated)
            throw DomainException.Unauthorized("not authenticated");

        var user = await users.GetByIdAsync(current.UserId, ct)
                   ?? throw DomainException.Unauthorized("user not found");

        return UserMapper.ToDto(user);
    }
}
