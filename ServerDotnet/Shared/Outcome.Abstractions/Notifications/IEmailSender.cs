namespace Outcome.Shared.Abstractions.Notifications;

/// <summary>Sends transactional email (e.g. 2FA codes). When SMTP is unconfigured the
/// implementation logs the message instead of sending, so the flow stays verifiable.</summary>
public interface IEmailSender
{
    Task SendAsync(string to, string subject, string body, CancellationToken ct = default);

    /// <summary>The same, with a Reply-To: a message sent on somebody's behalf (the landing's
    /// contact form) still leaves FROM our own address — anything else fails SPF — but answering
    /// it has to reach them.</summary>
    Task SendAsync(string to, string subject, string body, string? replyTo, CancellationToken ct);
}
