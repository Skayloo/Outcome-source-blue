using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Infrastructure.Tenancy;
using Outcome.Application.Common;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Api.Endpoints;

/// <summary>
/// The control plane: creating and running SPACES (tenants), as opposed to the servers users
/// create inside one. Root-space administrators only — a customer's own admin runs their
/// space, never the instance, so these routes are invisible from a tenant's subdomain.
/// </summary>
public static class SpaceAdminEndpoints
{
    public sealed record CreateSpaceBody(string? Slug, string? Name, string? Domain,
        string? OwnerEmail, string? OwnerUsername, string? OwnerPassword);
    public sealed record UpdateSpaceBody(string? Name, string? Domain, bool? Active);
    /// <summary>What the tenant's login screen shows. Icon "" clears it.</summary>
    public sealed record SpaceBrandingBody(string? Name, string? Icon);
    public sealed record SpaceOwnerBody(string? Email, string? Username, string? Password);
    /// <summary>Null = leave unchanged; "" = clear. Domains are comma-separated (w3g.group).</summary>
    public sealed record SpaceSsoBody(string? GoogleClientId, string? GoogleClientSecret,
        string? YandexClientId, string? YandexClientSecret, string? EmailDomains);

    /// <summary>Base64 inflates by ~4/3, so this is roughly a 512 KB image.</summary>
    private const int MaxIconBytes = 700_000;

    private static readonly Regex SlugRe = new("^[a-z][a-z0-9_]{1,30}$", RegexOptions.Compiled);
    private static readonly Regex DomainRe = new(@"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$", RegexOptions.Compiled);

    public static void MapSpaceAdminEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/admin/spaces");

        group.MapGet("/", async (ICurrentUser current, ICurrentSpace here, ISpaceRegistry spaces,
                                 IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var list = new List<object>();
            foreach (var s in await spaces.ListAsync(ct))
            {
                // Seat and server counts come from inside each tenant's own database.
                int users = 0, servers = 0;
                try
                {
                    await using var scope = scopes.CreateAsyncScopeFor(s);
                    users = await scope.ServiceProvider.GetRequiredService<IUserRepository>().CountAsync(ct);
                    servers = await scope.ServiceProvider.GetRequiredService<IServerRepository>().CountAllAsync(ct);
                }
                catch (Exception) { /* not provisioned yet — report zeros rather than failing the list */ }
                list.Add(new
                {
                    id = s.Id, slug = s.Slug, name = s.Name, domain = s.Domain,
                    db_name = s.DbName, active = s.Active, is_root = s.IsRoot,
                    user_count = users, server_count = servers,
                });
            }
            return Results.Ok(list);
        });

        group.MapPost("/", async (CreateSpaceBody body, ICurrentUser current, ICurrentSpace here,
                                  ISpaceRegistry spaces, SpaceProvisioner provisioner,
                                  IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var slug = (body.Slug ?? "").Trim().ToLowerInvariant();
            var name = (body.Name ?? "").Trim();
            if (!SlugRe.IsMatch(slug)) throw DomainException.BadRequest("slug must be lowercase letters, digits and underscores, e.g. core_otc");
            if (name.Length == 0) throw DomainException.BadRequest("name is required");
            var domain = NormalizeDomain(body.Domain);

            var existing = await spaces.ListAsync(ct);
            if (existing.Any(s => s.Slug == slug)) throw DomainException.Conflict("a space with this slug already exists");
            if (domain is not null && existing.Any(s => s.Domain == domain)) throw DomainException.Conflict("this domain is already in use");

            var space = await spaces.CreateAsync(slug, name, domain, ct);
            // The database is created and migrated NOW, so the space is usable the moment the
            // admin closes the dialog rather than on some later request.
            await provisioner.ProvisionAsync(space, ct);

            if (!string.IsNullOrWhiteSpace(body.OwnerEmail))
                await CreateOwnerAsync(scopes, space, body.OwnerEmail!, body.OwnerUsername, body.OwnerPassword, ct);

            return Results.Ok(new { id = space.Id, slug = space.Slug, name = space.Name, domain = space.Domain, db_name = space.DbName });
        });

        group.MapPut("/{id:long}", async (long id, UpdateSpaceBody body, ICurrentUser current, ICurrentSpace here,
                                          ISpaceRegistry spaces, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            var domain = body.Domain is null ? null : (NormalizeDomain(body.Domain) ?? "");
            if (domain is { Length: > 0 } && (await spaces.ListAsync(ct)).Any(s => s.Domain == domain && s.Id != id))
                throw DomainException.Conflict("this domain is already in use");
            if (space.IsRoot && body.Active == false) throw DomainException.BadRequest("the root space cannot be deactivated");

            await spaces.UpdateAsync(id, body.Name?.Trim(), domain, body.Active, ct);
            var updated = await spaces.ByIdAsync(id, ct);
            return Results.Ok(new { id, name = updated?.Name, domain = updated?.Domain, active = updated?.Active });
        });

        group.MapDelete("/{id:long}", async (long id, ICurrentUser current, ICurrentSpace here,
                                             ISpaceRegistry spaces, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            if (id == Space.RootId) throw DomainException.BadRequest("the root space cannot be deleted");
            if (!await spaces.DeleteAsync(id, ct)) throw DomainException.NotFound("space not found");
            // The database survives on purpose — see SpaceRegistry.DeleteAsync.
            return Results.NoContent();
        });

        // The login screen of a tenant's own domain: their name and their logo, both stored
        // in that space's settings (which is where the client reads them from).
        group.MapGet("/{id:long}/branding", async (long id, ICurrentUser current, ICurrentSpace here,
                                                   ISpaceRegistry spaces, IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            await using var scope = scopes.CreateAsyncScopeFor(space);
            var settings = scope.ServiceProvider.GetRequiredService<ISettingsRepository>();
            return Results.Ok(new
            {
                name = await settings.GetAsync("server_name", ct) ?? space.Name,
                icon = await settings.GetAsync("server_icon", ct) ?? "",
            });
        });

        group.MapPut("/{id:long}/branding", async (long id, SpaceBrandingBody body, ICurrentUser current, ICurrentSpace here,
                                                   ISpaceRegistry spaces, IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            var name = body.Name?.Trim();
            if (name is { Length: 0 }) throw DomainException.BadRequest("name cannot be empty");

            await using var scope = scopes.CreateAsyncScopeFor(space);
            var settings = scope.ServiceProvider.GetRequiredService<ISettingsRepository>();
            if (name is not null)
            {
                await settings.SetAsync("server_name", name, ct);
                // Keep the control-plane row in step, so the list and the login screen agree.
                await spaces.UpdateAsync(id, name, null, null, ct);
            }
            if (body.Icon is not null)
            {
                // Held inline as a data: URI rather than as an upload. An upload would land in
                // the ROOT space's attachments, and the tenant's login page resolves
                // /api/v1/files/{id} against ITS OWN database — where that row does not exist.
                var icon = body.Icon.Trim();
                if (icon.Length > MaxIconBytes) throw DomainException.BadRequest("logo is too large — use an image under 512 KB");
                if (icon.Length > 0 && !icon.StartsWith("data:image/", StringComparison.Ordinal))
                    throw DomainException.BadRequest("logo must be an image");
                await settings.SetAsync("server_icon", icon, ct);
            }
            return Results.NoContent();
        });

        // Everything below reads or writes INSIDE the named space.
        group.MapGet("/{id:long}/users", async (long id, ICurrentUser current, ICurrentSpace here,
                                                ISpaceRegistry spaces, IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            await using var scope = scopes.CreateAsyncScopeFor(space);
            var users = await scope.ServiceProvider.GetRequiredService<IUserRepository>().ListAdminUsersAsync(200, 0, null, ct);
            return Results.Ok(users);
        });

        group.MapGet("/{id:long}/servers", async (long id, ICurrentUser current, ICurrentSpace here,
                                                  ISpaceRegistry spaces, IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            await using var scope = scopes.CreateAsyncScopeFor(space);
            var servers = await scope.ServiceProvider.GetRequiredService<IServerRepository>().ListAllAsync(200, 0, ct);
            return Results.Ok(servers.Select(s => new { id = s.Id, name = s.Name, owner_id = s.OwnerId, icon = s.Icon }));
        });

        // A tenant's login story: their own OAuth app, and which mailboxes may use it.
        group.MapGet("/{id:long}/sso", async (long id, ICurrentUser current, ICurrentSpace here,
                                              ISpaceRegistry spaces, IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            await using var scope = scopes.CreateAsyncScopeFor(space);
            var settings = scope.ServiceProvider.GetRequiredService<ISettingsRepository>();
            return Results.Ok(new
            {
                google_client_id = await settings.GetAsync(SpaceSsoConfig.GoogleId, ct) ?? "",
                google_client_secret = await settings.GetAsync(SpaceSsoConfig.GoogleSecret, ct) ?? "",
                yandex_client_id = await settings.GetAsync(SpaceSsoConfig.YandexId, ct) ?? "",
                yandex_client_secret = await settings.GetAsync(SpaceSsoConfig.YandexSecret, ct) ?? "",
                email_domains = await settings.GetAsync(SpaceSsoConfig.EmailDomains, ct) ?? "",
                // What the provider must have registered as the redirect URI.
                callback_base = space.Domain is { Length: > 0 } d ? $"https://{d}" : "",
            });
        });

        group.MapPut("/{id:long}/sso", async (long id, SpaceSsoBody body, ICurrentUser current, ICurrentSpace here,
                                              ISpaceRegistry spaces, IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            await using var scope = scopes.CreateAsyncScopeFor(space);
            var settings = scope.ServiceProvider.GetRequiredService<ISettingsRepository>();
            foreach (var (key, value) in new[]
                     {
                         (SpaceSsoConfig.GoogleId, body.GoogleClientId),
                         (SpaceSsoConfig.GoogleSecret, body.GoogleClientSecret),
                         (SpaceSsoConfig.YandexId, body.YandexClientId),
                         (SpaceSsoConfig.YandexSecret, body.YandexClientSecret),
                         (SpaceSsoConfig.EmailDomains, body.EmailDomains),
                     })
            {
                if (value is null) continue; // untouched field
                await settings.SetAsync(key, value.Trim(), ct);
            }
            return Results.NoContent();
        });

        group.MapPost("/{id:long}/owner", async (long id, SpaceOwnerBody body, ICurrentUser current, ICurrentSpace here,
                                                 ISpaceRegistry spaces, IServiceScopeFactory scopes, CancellationToken ct) =>
        {
            RequireRootAdmin(current, here);
            var space = await spaces.ByIdAsync(id, ct) ?? throw DomainException.NotFound("space not found");
            var uid = await CreateOwnerAsync(scopes, space, body.Email ?? "", body.Username, body.Password, ct);
            return Results.Ok(new { id = uid });
        });
    }

    /// <summary>
    /// Seeds a space's first administrator. Without it the space is empty and the first
    /// stranger to open the subdomain would walk into the setup wizard and own it.
    /// </summary>
    private static async Task<long> CreateOwnerAsync(IServiceScopeFactory scopes, Space space,
        string email, string? username, string? password, CancellationToken ct)
    {
        email = email.Trim();
        var name = (username ?? "").Trim();
        if (AuthRules.ValidateEmail(email) is { } emailErr) throw DomainException.InvalidInput(emailErr);
        if (AuthRules.ValidateUsername(name) is { } nameErr) throw DomainException.InvalidInput(nameErr);
        if (AuthRules.ValidatePassword(password ?? "") is { } pwErr) throw DomainException.InvalidInput(pwErr);

        await using var scope = scopes.CreateAsyncScopeFor(space);
        var users = scope.ServiceProvider.GetRequiredService<IUserRepository>();
        var servers = scope.ServiceProvider.GetRequiredService<IServerRepository>();
        var userManager = scope.ServiceProvider.GetRequiredService<UserManager<User>>();

        if (await users.ExistsByEmailAsync(email, ct)) throw DomainException.Conflict("this email already exists in that space");
        if (await users.ExistsByUsernameAsync(name, ct)) throw DomainException.Conflict("this username already exists in that space");

        var owner = new User
        {
            UserName = name,
            Email = email,
            RoleId = Outcome.Domain.Permissions.DefaultRole.Owner,
            Status = "offline",
            EmailConfirmed = true,
        };
        var created = await userManager.CreateAsync(owner, password!);
        if (!created.Succeeded)
            throw DomainException.BadRequest(string.Join("; ", created.Errors.Select(e => e.Description)));

        // A space with no server is a dead end — give the owner one to land in.
        await servers.CreateAsync(space.Name, owner.Id, ct);
        return owner.Id;
    }

    private static void RequireRootAdmin(ICurrentUser current, ICurrentSpace here)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        if ((current.Permissions & Outcome.Domain.Permissions.Permission.Administrator) == 0)
            throw DomainException.Forbidden("administrator only");
        // A tenant admin owns their space, not the instance.
        if (!here.Space.IsRoot) throw DomainException.Forbidden("spaces are managed from the main instance");
    }

    private static string? NormalizeDomain(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var d = raw.Trim().ToLowerInvariant();
        if (d.Contains("://")) d = d[(d.IndexOf("://", StringComparison.Ordinal) + 3)..];
        d = d.Split('/')[0].Split('?')[0].Split(':')[0].TrimEnd('.');
        if (!DomainRe.IsMatch(d)) throw DomainException.BadRequest("enter a valid domain like team.outcome.ru");
        return d;
    }
}
