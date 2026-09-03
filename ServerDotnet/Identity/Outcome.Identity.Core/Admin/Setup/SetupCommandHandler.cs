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
using Outcome.Shared.Legal;

namespace Outcome.Application.Admin;

public sealed class SetupHandler(
    IUserRepository users,
    UserManager<User> userManager,
    IServerRepository servers,
    IInviteRepository invites,
    IAuditRepository audit,
    IJwtTokenService jwt,
    ISessionRepository sessions) : IRequestHandler<SetupCommand, SetupResult>
{
    public async Task<SetupResult> Handle(SetupCommand cmd, CancellationToken ct)
    {
        if (await users.CountAsync(ct) > 0)
            throw DomainException.Forbidden("setup has already been completed");

        var email = (cmd.Email ?? string.Empty).Trim();
        var username = TextSanitizer.StripHtml(cmd.Username);
        if (email.Length == 0 || username.Length == 0 || string.IsNullOrEmpty(cmd.Password))
            throw DomainException.BadRequest("email, username and password are required");
        if (AuthRules.ValidateEmail(email) is { } emailErr) throw DomainException.BadRequest(emailErr);
        if (AuthRules.ValidateUsername(username) is { } unameErr) throw DomainException.BadRequest(unameErr);
        if (AuthRules.ValidatePassword(cmd.Password) is { } pwErr) throw DomainException.BadRequest(pwErr);

        // The owner is a subject too, and this is the one account nobody can create twice.
        var user = new User
        {
            UserName = username, Email = email, RoleId = DefaultRole.Owner,
            Status = "offline", EmailConfirmed = true,
            ConsentAt = DateTime.UtcNow, ConsentVersion = PdnConsent.Version,
        };
        var created = await userManager.CreateAsync(user, cmd.Password);
        if (!created.Succeeded)
            throw DomainException.BadRequest(string.Join("; ", created.Errors.Select(e => e.Description)));
        var uid = user.Id;

        var token = jwt.Issue(uid);
        await SessionIssuer.RecordAsync(sessions, jwt, uid, token, null, null, ct);

        // First server (tenant) + its default channels + owner membership.
        var server = await servers.CreateAsync("Outcome", uid, ct);

        // Bootstrap invite (unlimited, no expiry) — scoped to the first server.
        var invite = new Invite { ServerId = server.Id, Code = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(5)), CreatedBy = uid };
        await invites.CreateAsync(invite, ct);

        await audit.AddAsync(uid, "server_setup", "server", 0, "initial setup: owner account + default channels + invite", ct);

        return new SetupResult(token, uid, username, invite.Code);
    }
}
