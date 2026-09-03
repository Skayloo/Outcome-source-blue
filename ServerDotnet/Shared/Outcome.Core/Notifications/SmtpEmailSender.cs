using System.Net;
using System.Net.Mail;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Domain.Errors;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Notifications;

/// <summary>
/// SMTP email sender (System.Net.Mail). If <see cref="EmailOptions.Host"/> is blank, the email
/// is not sent — it is logged at warning level instead, so 2FA codes remain verifiable without
/// SMTP credentials configured.
/// </summary>
public sealed class SmtpEmailSender(IOptions<EmailOptions> options, ILogger<SmtpEmailSender> logger) : IEmailSender
{
    public async Task SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        var o = options.Value;

        if (string.IsNullOrWhiteSpace(o.Host))
        {
            logger.LogWarning(
                "SMTP not configured — email NOT sent (logged for verification). To={To} | Subject={Subject} | Body={Body}",
                to, subject, body);
            return;
        }

        using var message = new MailMessage
        {
            From = new MailAddress(o.From, o.FromName),
            Subject = subject,
            Body = body,
            IsBodyHtml = false,
        };
        message.To.Add(to);

        // System.Net.Mail does not write a Message-ID, and this relay's Postfix is configured
        // with always_add_missing_headers = no — so the message left without one. A message
        // with no Message-ID is malformed by RFC 5322 and is a well-known filtering signal:
        // the receiver accepts it with 250 OK and quietly files it as spam, which reads from
        // our side as "sent" and from the recipient's as "never arrived". Found exactly that
        // way — reset codes reaching Gmail and vanishing.
        //
        // Built from the sender's own domain, because the identifier is supposed to be unique
        // to the system that created the message and traceable back to it.
        var host = o.From.Contains('@') ? o.From[(o.From.IndexOf('@') + 1)..] : "outcome";
        message.Headers.Add("Message-ID", $"<{Guid.NewGuid():N}@{host}>");

        using var client = new SmtpClient(o.Host, o.Port)
        {
            EnableSsl = o.UseSsl,
            Credentials = string.IsNullOrEmpty(o.Username) ? null : new NetworkCredential(o.Username, o.Password),
        };

        try
        {
            await client.SendMailAsync(message, ct);
        }
        catch (SmtpException ex)
        {
            // A mail outage is not a bug in the request, and a 500 tells the person in front
            // of the screen nothing they can act on — so they press the button again, which
            // sends nothing again. Log the real reason for us; give them a 503 and words that
            // say whose problem it is and that it is worth retrying.
            //
            // Seen in production as "Insufficient system storage": the mail host had filled
            // its disk, and password reset answered 500 for everyone.
            logger.LogError(ex, "SMTP send failed for {To} ({Subject}) — {Status}", to, subject, ex.StatusCode);
            throw DomainException.Unavailable(
                "не удалось отправить письмо — почтовый сервер сейчас недоступен, попробуйте через несколько минут");
        }
        logger.LogInformation("Email sent to {To} ({Subject})", to, subject);
    }
}
