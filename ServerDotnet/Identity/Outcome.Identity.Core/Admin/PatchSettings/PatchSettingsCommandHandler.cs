using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

public sealed class PatchSettingsHandler(ISettingsRepository settings)
    : IRequestHandler<PatchSettingsCommand, IReadOnlyDictionary<string, string>>
{
    private static readonly HashSet<string> Allowed = new()
    {
        "server_name", "server_icon", "motd", "max_upload_bytes", "voice_quality",
        // Per-space SSO: each tenant brings its own OAuth app and its own mail-domain policy.
        "sso_google_client_id", "sso_google_client_secret",
        "sso_yandex_client_id", "sso_yandex_client_secret", "sso_email_domains",
        "require_2fa", "email_2fa", "registration_open", "registration_invite_only", "registration_email_verify",
        "backup_schedule", "backup_retention",
    };

    public async Task<IReadOnlyDictionary<string, string>> Handle(PatchSettingsCommand cmd, CancellationToken ct)
    {
        AdminAuth.Require(cmd.Permissions, Outcome.Shared.Abstractions.Authorization.Permissions.ManageServer);
        foreach (var (key, value) in cmd.Settings)
            if (Allowed.Contains(key))
                await settings.SetAsync(key, value, ct);
        return await settings.GetAllAsync(ct);
    }
}
