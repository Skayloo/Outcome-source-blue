using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
using MailKit.Search;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MimeKit;
using Outcome.Domain.Errors;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Mail;

/// <summary>One message as the admin panel lists it. The body is not here: a listing that
/// downloads every message is a listing that takes a minute.</summary>
public sealed record SupportMailSummary(
    uint Uid, string From, string FromName, string Subject, DateTimeOffset Date, bool Seen, string Preview);

/// <summary>A single message, opened.</summary>
public sealed record SupportMailMessage(
    uint Uid, string From, string FromName, string Subject, DateTimeOffset Date, string Body, bool HtmlOnly);

/// <summary>
/// The support mailbox, read and answered over IMAP/SMTP.
///
/// <para>Deliberately not a background sync into our database. A mailbox is already a durable
/// store with its own read state, and copying it here would mean owning the copy — dedup,
/// deletion, flags drifting apart. Every call opens a connection, does one thing and closes:
/// this is a queue somebody looks at a few times a day, not a hot path.</para>
///
/// <para>Everything in here is UNTRUSTED input. Anyone on the internet can write to this
/// address, and what they send is rendered in an admin's browser — so nothing is passed
/// through as HTML, and the size of what we download is capped.</para>
/// </summary>
public sealed class SupportMailbox(IOptions<SupportMailOptions> options, ILogger<SupportMailbox> log)
{
    private readonly SupportMailOptions _opt = options.Value;

    public bool Configured => !string.IsNullOrWhiteSpace(_opt.Host)
        && !string.IsNullOrWhiteSpace(_opt.Username);

    /// <summary>Longest body we will pull into memory. A mail server will happily hand over a
    /// 30 MB message; the panel shows a support request, and anything past this is a signal to
    /// open a real client rather than something to render.</summary>
    private const int MaxBodyChars = 100_000;
    private const int PreviewChars = 160;

    private void RequireConfigured()
    {
        if (!Configured)
            throw DomainException.BadRequest("the support mailbox is not configured on this server");
    }

    private async Task<ImapClient> ConnectAsync(CancellationToken ct)
    {
        var client = new ImapClient();
        try
        {
            await client.ConnectAsync(_opt.Host, _opt.Port,
                _opt.UseSsl ? MailKit.Security.SecureSocketOptions.SslOnConnect
                            : MailKit.Security.SecureSocketOptions.StartTls, ct);
            await client.AuthenticateAsync(_opt.Username, _opt.Password, ct);
            return client;
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    /// <summary>Newest first, which is the order a queue is worked in.</summary>
    public async Task<IReadOnlyList<SupportMailSummary>> ListAsync(int limit, int offset, CancellationToken ct = default)
    {
        RequireConfigured();
        limit = Math.Clamp(limit, 1, _opt.MaxMessages);
        offset = Math.Max(offset, 0);

        using var client = await ConnectAsync(ct);
        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadOnly, ct);

        // Ask for the envelope and the flags only. Fetching BODY here is what turns a page of
        // twenty into twenty round trips of unbounded size.
        var uids = await inbox.SearchAsync(SearchQuery.All, ct);
        var page = uids.Reverse().Skip(offset).Take(limit).ToList();
        if (page.Count == 0) return [];

        var items = await inbox.FetchAsync(page, MessageSummaryItems.Envelope | MessageSummaryItems.Flags
            | MessageSummaryItems.UniqueId | MessageSummaryItems.PreviewText, ct);

        return items
            .OrderByDescending(m => m.UniqueId.Id)
            .Select(m =>
            {
                var from = m.Envelope?.From.Mailboxes.FirstOrDefault();
                return new SupportMailSummary(
                    m.UniqueId.Id,
                    from?.Address ?? "",
                    from?.Name ?? "",
                    m.Envelope?.Subject ?? "",
                    m.Envelope?.Date ?? DateTimeOffset.MinValue,
                    m.Flags?.HasFlag(MessageFlags.Seen) ?? false,
                    Trim(m.PreviewText ?? "", PreviewChars));
            })
            .ToList();
    }

    /// <summary>Open one message and mark it read — opening it in the panel is reading it, and
    /// a queue where nothing is ever marked read is a queue nobody can share.</summary>
    public async Task<SupportMailMessage> GetAsync(uint uid, CancellationToken ct = default)
    {
        RequireConfigured();
        using var client = await ConnectAsync(ct);
        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadWrite, ct);

        var id = new UniqueId(uid);
        var message = await inbox.GetMessageAsync(id, ct)
            ?? throw DomainException.NotFound("message not found");
        await inbox.AddFlagsAsync(id, MessageFlags.Seen, true, ct);

        var from = message.From.Mailboxes.FirstOrDefault();
        // Plain text if the sender bothered to send it. If they did not, the HTML is converted
        // to text rather than handed to the browser: this arrives from strangers and is shown
        // to an administrator, so it never gets to be markup.
        var htmlOnly = string.IsNullOrEmpty(message.TextBody) && !string.IsNullOrEmpty(message.HtmlBody);
        var body = message.TextBody ?? (message.HtmlBody is null ? "" : StripHtml(message.HtmlBody));

        return new SupportMailMessage(
            uid, from?.Address ?? "", from?.Name ?? "", message.Subject ?? "",
            message.Date, Trim(body, MaxBodyChars), htmlOnly);
    }

    /// <summary>Answer a message as the mailbox itself, threaded so the sender's client files
    /// it under the conversation they started rather than as a new one.</summary>
    public async Task ReplyAsync(uint uid, string text, CancellationToken ct = default)
    {
        RequireConfigured();
        if (string.IsNullOrWhiteSpace(text))
            throw DomainException.BadRequest("the reply is empty");

        using var imap = await ConnectAsync(ct);
        var inbox = imap.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadOnly, ct);
        var original = await inbox.GetMessageAsync(new UniqueId(uid), ct)
            ?? throw DomainException.NotFound("message not found");

        var to = original.From.Mailboxes.FirstOrDefault()
            ?? throw DomainException.BadRequest("the original message has no sender to answer");

        var fromAddress = string.IsNullOrWhiteSpace(_opt.From) ? _opt.Username : _opt.From;
        var reply = new MimeMessage();
        reply.From.Add(new MailboxAddress(_opt.FromName, fromAddress));
        reply.To.Add(to);
        reply.Subject = original.Subject?.StartsWith("Re:", StringComparison.OrdinalIgnoreCase) == true
            ? original.Subject
            : "Re: " + (original.Subject ?? "");

        // Threading: In-Reply-To alone is enough for most clients, References is what keeps a
        // long conversation in one thread. Without them the answer arrives as a new message and
        // the person has to work out what it is about.
        if (!string.IsNullOrEmpty(original.MessageId))
        {
            reply.InReplyTo = original.MessageId;
            foreach (var r in original.References) reply.References.Add(r);
            reply.References.Add(original.MessageId);
        }

        reply.Body = new TextPart("plain") { Text = text };

        using var smtp = new SmtpClient();
        var host = string.IsNullOrWhiteSpace(_opt.SmtpHost) ? _opt.Host : _opt.SmtpHost;
        await smtp.ConnectAsync(host, _opt.SmtpPort,
            _opt.SmtpPort == 587 ? MailKit.Security.SecureSocketOptions.StartTls
                                 : MailKit.Security.SecureSocketOptions.SslOnConnect, ct);
        await smtp.AuthenticateAsync(_opt.Username, _opt.Password, ct);
        await smtp.SendAsync(reply, ct);
        await smtp.DisconnectAsync(true, ct);

        log.LogInformation("support mail: replied to {Address}", to.Address);
    }

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    /// <summary>Tags out, entities decoded, whitespace collapsed. Not a sanitiser — the result
    /// is rendered as TEXT, and this only exists so an HTML-only message is readable at all.</summary>
    private static string StripHtml(string html)
    {
        var text = System.Text.RegularExpressions.Regex.Replace(
            html, "<(script|style)[^>]*>.*?</\\1>", " ",
            System.Text.RegularExpressions.RegexOptions.Singleline
            | System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        text = System.Text.RegularExpressions.Regex.Replace(text, "<br\\s*/?>|</p>", "\n",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        text = System.Text.RegularExpressions.Regex.Replace(text, "<[^>]+>", "");
        text = System.Net.WebUtility.HtmlDecode(text);
        return System.Text.RegularExpressions.Regex.Replace(text, "[ \\t]{2,}", " ").Trim();
    }
}
