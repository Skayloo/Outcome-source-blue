namespace Outcome.Infrastructure.Configuration;

/// <summary>
/// The shared mailbox the admin panel reads and answers from, bound from the
/// <c>SupportMail</c> section (<c>OUTCOME_SupportMail__Host</c> and so on).
///
/// <para>Separate from <see cref="EmailOptions"/> on purpose: that one is a one-way sender for
/// verification codes, addressed FROM no-reply and never read. This is a person's inbox — a
/// different mailbox, different credentials, and the only one whose replies should carry a
/// reply-to anybody can actually write back to.</para>
///
/// <para>Leave <see cref="Host"/> empty and the feature is simply off: the endpoints answer
/// "not configured" rather than failing, and the panel says so instead of showing an error.</para>
/// </summary>
public sealed class SupportMailOptions
{
    /// <summary>IMAP host. Empty ⇒ the mailbox is not configured and the panel stays dark.</summary>
    public string Host { get; set; } = "";

    /// <summary>IMAPS. 143 with <see cref="UseSsl"/> false is STARTTLS, which our server does
    /// not publish — it exposes 993 only.</summary>
    public int Port { get; set; } = 993;

    public bool UseSsl { get; set; } = true;

    /// <summary>Full address; docker-mailserver authenticates by it, not by a short name.</summary>
    public string Username { get; set; } = "";

    public string Password { get; set; } = "";

    /// <summary>What replies are sent AS. Defaults to <see cref="Username"/> when left empty,
    /// which is the usual case — the mailbox answers as itself.</summary>
    public string From { get; set; } = "";

    public string FromName { get; set; } = "Outcome";

    /// <summary>SMTP host for replies. Empty ⇒ reuse <see cref="Host"/>: the same server holds
    /// this mailbox, and sending from anywhere else would fail SPF for the domain.</summary>
    public string SmtpHost { get; set; } = "";

    /// <summary>Implicit TLS. 587 (STARTTLS) also works if the server prefers it.</summary>
    public int SmtpPort { get; set; } = 465;

    /// <summary>How many messages the panel lists at most. The mailbox is a support queue, not
    /// an archive; anything older is read in a real mail client.</summary>
    public int MaxMessages { get; set; } = 200;
}
