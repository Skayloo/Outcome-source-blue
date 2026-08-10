using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed class UpdateProfileHandler(IUserRepository users, IRoleRepository roles)
    : IRequestHandler<UpdateProfileCommand, MemberProfileDto>
{
    public async Task<MemberProfileDto> Handle(UpdateProfileCommand cmd, CancellationToken ct)
    {
        var current = await users.GetByIdAsync(cmd.UserId, ct)
                      ?? throw DomainException.Unauthorized("user not found");

        string? newUsername = null;
        if (cmd.Username is not null)
        {
            var username = TextSanitizer.StripHtml(cmd.Username);
            if (!string.Equals(username, current.Username, StringComparison.OrdinalIgnoreCase))
            {
                if (AuthRules.ValidateUsername(username) is { } err) throw DomainException.BadRequest(err);
                if (await users.ExistsByUsernameAsync(username, ct))
                    throw DomainException.Conflict("username is already taken");
                newUsername = username;
            }
        }

        // Avatar: null = unchanged; a value (including "") sets it. Cap to a sane size to avoid abuse.
        string? newAvatar = cmd.Avatar;
        if (newAvatar is { Length: > 2_000_000 })
            throw DomainException.BadRequest("avatar is too large");

        // E2EE identity key: null = unchanged. Base64 of a 32-byte X25519 key (~44 chars); cap generously.
        string? newPublicKey = cmd.PublicKey;
        if (newPublicKey is { Length: > 1000 })
            throw DomainException.BadRequest("public key is too large");

        // E2EE key backup: null = unchanged. Opaque, password-wrapped secret key (~120 chars); cap generously.
        string? newBackup = cmd.E2eeBackup;
        if (newBackup is { Length: > 4000 })
            throw DomainException.BadRequest("e2ee backup is too large");

        if (newUsername is not null || newAvatar is not null || newPublicKey is not null || newBackup is not null
            || cmd.PushPreview is not null)
            await users.UpdateProfileAsync(cmd.UserId, newUsername, newAvatar, newPublicKey, newBackup, cmd.PushPreview, ct);

        return await MemberProfile.BuildAsync(users, roles, cmd.UserId, ct);
    }
}
