using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

/// <summary>Self profile shape matching the client's MemberResponse (role NAME, avatar nullable).</summary>
public sealed record MemberProfileDto(
    long Id, string Username, string? Avatar, string Role, string Status, bool TotpEnabled, DateTime CreatedAt,
    /// <summary>False ⇒ SSO-only account with no password of its own, so the client asks it to
    /// set one before handing over the app: until it does, nothing can seal its key backup.</summary>
    bool PasswordSet,
    /// <summary>Show message text in push notifications, or only who sent it.</summary>
    bool PushPreview);

internal static class MemberProfile
{
    public static async Task<MemberProfileDto> BuildAsync(
        IUserRepository users, IRoleRepository roles, long userId, CancellationToken ct)
    {
        var user = await users.GetByIdAsync(userId, ct)
                   ?? throw DomainException.Unauthorized("user not found");
        var role = await roles.GetByIdAsync(user.RoleId, ct);
        return new MemberProfileDto(
            user.Id, user.Username,
            string.IsNullOrEmpty(user.Avatar) ? null : user.Avatar,
            (role?.Name ?? "member").ToLowerInvariant(),
            user.Status, user.TotpSecret is not null, user.CreatedAt,
            user.PasswordSet, user.PushPreview);
    }
}
