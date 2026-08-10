using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Notifications;

namespace Outcome.Application.Auth;

public sealed class ForgotPasswordHandler(
    IUserRepository users,
    IPasswordResetStore resetStore,
    IRateLimiter limiter,
    IEmailSender emailSender,
    IAuditRepository audit) : IRequestHandler<ForgotPasswordCommand>
{
    public async Task Handle(ForgotPasswordCommand cmd, CancellationToken ct)
    {
        var email = (cmd.Email ?? string.Empty).Trim();
        if (email.Length == 0) return; // silent: the caller must not learn anything from the shape

        // Per-address budget so this can't be used to bomb a victim's inbox. Checked BEFORE the
        // user lookup so the rate limit itself can't be probed for account existence.
        if (!limiter.Allow($"pwreset:{email.ToLowerInvariant()}", 3, TimeSpan.FromMinutes(15)))
            return;

        var user = await users.GetByEmailAsync(email, ct);
        // No account (or an SSO account whose email we still trust): only send when a user exists,
        // but return the SAME empty response either way so existence never leaks.
        if (user is null) return;

        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        resetStore.Issue(email, code);
        await emailSender.SendAsync(email, "Your Outcome password reset code",
            $"Your password reset code is {code}. It expires in 10 minutes. " +
            "If you didn't request this, you can ignore this email.", ct);
        await audit.AddAsync(user.Id, "password_reset_code_sent", "user", user.Id, $"reset code sent to {email}", ct);
    }
}
