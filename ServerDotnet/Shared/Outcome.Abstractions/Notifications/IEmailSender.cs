namespace Outcome.Shared.Abstractions.Notifications;

/// <summary>Sends transactional email (e.g. 2FA codes). When SMTP is unconfigured the
/// implementation logs the message instead of sending, so the flow stays verifiable.</summary>
public interface IEmailSender
{
    Task SendAsync(string to, string subject, string body, CancellationToken ct = default);
}
