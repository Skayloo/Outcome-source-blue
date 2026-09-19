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
        // Store one of OUR file paths BARE, with any signature cut off.
        //
        // The client sends back what the upload handed it, and that is a SIGNED url — id, expiry
        // and MAC. Stored whole it stops working a week later, and worse than it looks: the file
        // endpoint lets an avatar through unsigned by matching the stored value against the
        // REQUEST path, which never carries the query, so the exemption misses and the picture
        // 404s with or without the signature. Two of four avatars on the live server were in that
        // state; the same mistake in servers.icon is what StripServerIconSignature fixed.
        //
        // Only our own paths are touched: an avatar may also be a data: URI, and '?' is legal
        // inside one.
        if (newAvatar is not null && newAvatar.StartsWith("/api/v1/files/", StringComparison.Ordinal)
            && newAvatar.IndexOf('?') is var q && q > 0)
            newAvatar = newAvatar[..q];

        if (newUsername is not null || newAvatar is not null || cmd.PushPreview is not null)
            await users.UpdateProfileAsync(cmd.UserId, newUsername, newAvatar, cmd.PushPreview, ct);

        return await MemberProfile.BuildAsync(users, roles, cmd.UserId, ct);
    }
}
