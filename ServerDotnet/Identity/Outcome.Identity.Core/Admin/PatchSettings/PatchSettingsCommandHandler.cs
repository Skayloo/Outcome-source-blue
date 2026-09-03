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
        // Whether a registration without a personal-data consent is refused. Per space, because
        // the obligation belongs to whoever operates one — ON for ours, and nobody else's
        // business.
        "registration_pdn_consent",
        // Пишет ли журнал сам код из письма. ВЫКЛЮЧЕНА по умолчанию и должна такой оставаться
        // вне отладки: код — короткоживущий ключ от учётной записи, и журнал, который читают в
        // вебе и который где-то хранится, — ровно та дорожка, по которой такие вещи утекают.
        "debug_email_codes",
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
