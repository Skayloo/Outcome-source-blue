using Microsoft.Extensions.Options;
using Outcome.Infrastructure.Configuration;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Infrastructure.Tenancy;

/// <summary>
/// SSO configuration for the CURRENT space. Each tenant sells its own login story — CoreOTC
/// wants Google restricted to their corporate mail domain, the main instance wants Google off
/// entirely — so the keys live in the space's own settings table, not in instance-wide env
/// vars. Env values remain the fallback for the root space, so an existing deployment keeps
/// working without being re-entered in the panel.
/// </summary>
public interface ISpaceSsoConfig
{
    Task<OAuthProviderOptions> ProviderAsync(string provider, CancellationToken ct = default);
    /// <summary>Comma-separated mail domains allowed to sign in through SSO here. Empty = any.</summary>
    Task<IReadOnlyList<string>> AllowedEmailDomainsAsync(CancellationToken ct = default);
    Task<string> PublicOriginAsync(CancellationToken ct = default);
}

public sealed class SpaceSsoConfig(ISettingsRepository settings, ICurrentSpace space, IOptions<OAuthOptions> env) : ISpaceSsoConfig
{
    public const string GoogleId = "sso_google_client_id";
    public const string GoogleSecret = "sso_google_client_secret";
    public const string YandexId = "sso_yandex_client_id";
    public const string YandexSecret = "sso_yandex_client_secret";
    public const string EmailDomains = "sso_email_domains";

    public async Task<OAuthProviderOptions> ProviderAsync(string provider, CancellationToken ct = default)
    {
        var (idKey, secretKey) = provider == "google" ? (GoogleId, GoogleSecret) : (YandexId, YandexSecret);
        var id = (await settings.GetAsync(idKey, ct) ?? "").Trim();
        var secret = (await settings.GetAsync(secretKey, ct) ?? "").Trim();

        // Root keeps its env-configured keys until someone types keys into the panel; a tenant
        // has no env of its own, so blank there means "this provider is off here".
        if (id.Length == 0 && secret.Length == 0 && space.Space.IsRoot)
            return provider == "google" ? env.Value.Google : env.Value.Yandex;

        return new OAuthProviderOptions { ClientId = id, ClientSecret = secret };
    }

    public async Task<IReadOnlyList<string>> AllowedEmailDomainsAsync(CancellationToken ct = default) =>
        (await settings.GetAsync(EmailDomains, ct) ?? "")
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(d => d.TrimStart('@').ToLowerInvariant())
            .ToList();

    public async Task<string> PublicOriginAsync(CancellationToken ct = default)
    {
        // A tenant's callback must come back to ITS host, or Google returns the user to the
        // wrong space (and the redirect_uri won't match what was registered).
        if (space.Space.Domain is { Length: > 0 } domain) return $"https://{domain}";
        _ = ct;
        return env.Value.PublicOrigin;
    }

    /// <summary>Whether this mailbox may sign in here at all.</summary>
    public static bool EmailAllowed(string email, IReadOnlyList<string> allowedDomains)
    {
        if (allowedDomains.Count == 0) return true;
        var at = email.LastIndexOf('@');
        if (at < 0) return false;
        var domain = email[(at + 1)..].ToLowerInvariant();
        return allowedDomains.Any(d => domain == d || domain.EndsWith("." + d, StringComparison.Ordinal));
    }
}
