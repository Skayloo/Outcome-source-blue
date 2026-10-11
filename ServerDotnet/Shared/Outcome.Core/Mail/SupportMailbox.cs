using System.Text.RegularExpressions;
using Ganss.Xss;
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

/// <summary>A folder as the panel lists it: its id (<see cref="SupportMailbox.FolderIds"/>) and counts.</summary>
public sealed record SupportMailFolder(string Id, int Total, int Unread);

/// <summary>One message in a folder's list. The body is not here: a listing that downloads every
/// message is a listing that takes a minute.</summary>
public sealed record SupportMailSummary(
    uint Uid, string From, string FromName, IReadOnlyList<string> To, string Subject, DateTimeOffset Date,
    bool Seen, bool Flagged, bool Answered, bool HasAttachments, string Preview);

public sealed record SupportMailPage(int Total, IReadOnlyList<SupportMailSummary> Messages);

/// <summary>A file in a message. <see cref="Index"/> is its position in <see cref="SupportMailbox"/>'s
/// own enumeration of the message's files — the same index downloads it or carries it into a
/// forward.</summary>
public sealed record SupportMailAttachment(int Index, string FileName, string Mime, long Size);

/// <summary>A single message, opened. <see cref="Html"/> is SANITISED markup for a sandboxed
/// frame (scripts, forms, frames, event handlers gone; inline cid: images turned into data:);
/// remote images are still in it, and the panel's frame blocks them until asked
/// (<see cref="RemoteImages"/> says whether there are any). <see cref="Text"/> is always there.</summary>
public sealed record SupportMailMessage(
    uint Uid, string Folder, string From, string FromName, IReadOnlyList<string> To, IReadOnlyList<string> Cc,
    string? ReplyTo, string Subject, DateTimeOffset Date, string Text, string? Html, bool RemoteImages,
    IReadOnlyList<SupportMailAttachment> Attachments, bool Flagged, bool IsDraft);

/// <summary>A file the administrator attached in the panel.</summary>
public sealed record SupportMailFile(string FileName, string Mime, byte[] Data);

/// <summary>A file of a message already in the mailbox, carried into a new one — a forward's
/// originals, a draft's attachments.</summary>
public sealed record SupportMailAttachmentRef(string Folder, uint Uid, int Index);

/// <summary>A message written in the panel: sent, or kept as a draft.</summary>
public sealed record SupportMailOutgoing(
    IReadOnlyList<string> To, IReadOnlyList<string> Cc, string Subject, string Text,
    string? ReplyFolder, uint? ReplyUid, uint? DraftUid,
    IReadOnlyList<SupportMailAttachmentRef> Keep, IReadOnlyList<SupportMailFile> Files);

/// <summary>
/// The support mailbox, read and answered over IMAP/SMTP — a small mail client behind the admin
/// panel: Inbox, Sent, Drafts, Spam, Trash, with search, flags, moving, deleting and writing.
///
/// <para>Deliberately not a background sync into our database. A mailbox is already a durable
/// store with its own read state, and copying it here would mean owning the copy — dedup,
/// deletion, flags drifting apart. Every call opens a connection, does one thing and closes:
/// this is a queue somebody looks at a few times a day, not a hot path.</para>
///
/// <para>Everything in here is UNTRUSTED input. Anyone on the internet can write to this
/// address, and what they send is rendered in an admin's browser: HTML is sanitised here AND
/// shown in a sandboxed frame without scripts, under a policy that loads nothing remote until
/// the administrator asks (a remote image tells the sender the message was opened).</para>
///
/// <para>Spam learning is the mail server's: moving a message into or out of Junk over IMAP is
/// what docker-mailserver's <c>RSPAMD_LEARN</c> listens to — nothing here talks to Rspamd.</para>
/// </summary>
public sealed class SupportMailbox(IOptions<SupportMailOptions> options, ILogger<SupportMailbox> log)
{
    private readonly SupportMailOptions _opt = options.Value;

    /// <summary>The folders the panel knows, in the order it shows them.</summary>
    public static readonly string[] FolderIds = ["inbox", "sent", "drafts", "junk", "trash"];

    public bool Configured => !string.IsNullOrWhiteSpace(_opt.Host)
        && !string.IsNullOrWhiteSpace(_opt.Username);

    /// <summary>The address the mailbox writes as.</summary>
    public string Address => string.IsNullOrWhiteSpace(_opt.From) ? _opt.Username : _opt.From;

    /// <summary>Longest text body we pull into memory. A mail server will happily hand over a
    /// 30 MB message; anything past this is a signal to open a real client.</summary>
    private const int MaxBodyChars = 200_000;
    private const int PreviewChars = 160;
    /// <summary>Inline (cid:) images turned into data: URIs, each — a larger one stays a file.</summary>
    private const int MaxInlineImageBytes = 3 * 1024 * 1024;
    /// <summary>All files of one outgoing message. Base64 grows them by a third, and the mail
    /// server takes 25 MB (<c>POSTFIX_MESSAGE_SIZE_LIMIT</c>), as do the big providers.</summary>
    public const long MaxOutgoingFileBytes = 18L * 1024 * 1024;
    private const int MaxRecipients = 50;

    /// <summary>Give up on a silent server before the proxies in front of us give up on the
    /// request — MailKit's own default is two minutes.</summary>
    private const int TimeoutMs = 20_000;

    private void RequireConfigured()
    {
        if (!Configured)
            throw DomainException.BadRequest("the support mailbox is not configured on this server");
    }

    /// <summary>
    /// No ONLINE revocation check of the mail server's certificate (the chain and the host name
    /// are still verified). MailKit asks for one by default, so .NET downloads Let's Encrypt's
    /// CRL during the handshake — and from production's home network one of the two addresses
    /// <c>*.c.lencr.org</c> resolves to (8.6.112.0) does not answer at all. Whenever the cached
    /// CRL had run out and the resolver picked that one, the download hung, validation failed and
    /// the panel's mailbox was a bare 500 (2026-10-07: the IMAP session sat 35 s after TLS without
    /// ever logging in). This is our own server under a 90-day certificate; a revocation answer
    /// we cannot reliably fetch protects nothing and only takes the inbox down.
    /// </summary>
    private static void Prepare(MailService client)
    {
        client.CheckCertificateRevocation = false;
        client.Timeout = TimeoutMs;
    }

    /// <summary>What reaches the panel when the mail server cannot be talked to: a 503 that
    /// says so, not an anonymous 500 that reads like our own bug.</summary>
    private DomainException Unreachable(Exception e, string what)
    {
        log.LogWarning(e, "support mail: {What} failed", what);
        return DomainException.Unavailable($"the mail server could not be reached ({what}): {e.Message}");
    }

    private async Task<ImapClient> ConnectAsync(CancellationToken ct)
    {
        RequireConfigured();
        var client = new ImapClient();
        Prepare(client);
        try
        {
            await client.ConnectAsync(_opt.Host, _opt.Port,
                _opt.UseSsl ? MailKit.Security.SecureSocketOptions.SslOnConnect
                            : MailKit.Security.SecureSocketOptions.StartTls, ct);
            await client.AuthenticateAsync(_opt.Username, _opt.Password, ct);
            return client;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            client.Dispose();
            throw Unreachable(e, "IMAP");
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    /// <summary>A folder by the panel's id. The special ones are found by their SPECIAL-USE flag
    /// (RFC 6154) — names differ between servers and languages — and by name only as a fallback.</summary>
    private static IMailFolder Resolve(ImapClient client, string id)
    {
        if (id == "inbox") return client.Inbox;
        var (kind, name) = id switch
        {
            "sent" => (SpecialFolder.Sent, "Sent"),
            "drafts" => (SpecialFolder.Drafts, "Drafts"),
            "junk" => (SpecialFolder.Junk, "Junk"),
            "trash" => (SpecialFolder.Trash, "Trash"),
            _ => throw DomainException.InvalidInput("unknown folder"),
        };
        if ((client.Capabilities & (ImapCapabilities.SpecialUse | ImapCapabilities.XList)) != 0)
        {
            try
            {
                if (client.GetFolder(kind) is { } special) return special;
            }
            catch (NotSupportedException) { /* fall through to the name */ }
        }
        return client.GetFolder(name);
    }

    public async Task<IReadOnlyList<SupportMailFolder>> FoldersAsync(CancellationToken ct = default)
    {
        using var client = await ConnectAsync(ct);
        var result = new List<SupportMailFolder>();
        foreach (var id in FolderIds)
        {
            var folder = Resolve(client, id);
            await folder.StatusAsync(StatusItems.Count | StatusItems.Unread, ct);
            result.Add(new SupportMailFolder(id, folder.Count, folder.Unread));
        }
        return result;
    }

    /// <summary>Newest first, which is the order a queue is worked in. <paramref name="query"/>
    /// searches subject, sender, recipients and text on the server.</summary>
    public async Task<SupportMailPage> ListAsync(string folderId, int limit, int offset, string? query, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, Math.Max(1, _opt.MaxMessages));
        offset = Math.Max(offset, 0);

        using var client = await ConnectAsync(ct);
        var folder = Resolve(client, folderId);
        await folder.OpenAsync(FolderAccess.ReadOnly, ct);

        var q = (query ?? "").Trim();
        var search = q.Length == 0
            ? SearchQuery.All
            : SearchQuery.SubjectContains(q).Or(SearchQuery.FromContains(q))
                .Or(SearchQuery.ToContains(q)).Or(SearchQuery.BodyContains(q));
        var uids = await folder.SearchAsync(search, ct);
        var page = uids.Reverse().Skip(offset).Take(limit).ToList();
        if (page.Count == 0) return new SupportMailPage(uids.Count, []);

        // Envelope and flags, the preview line, and the structure — the structure only to say
        // whether there is a paperclip. Fetching BODY here is what turns a page of fifty into
        // fifty round trips of unbounded size.
        var items = await folder.FetchAsync(page, MessageSummaryItems.Envelope | MessageSummaryItems.Flags
            | MessageSummaryItems.UniqueId | MessageSummaryItems.PreviewText | MessageSummaryItems.BodyStructure, ct);

        var messages = items
            .OrderByDescending(m => m.UniqueId.Id)
            .Select(m =>
            {
                var from = m.Envelope?.From.Mailboxes.FirstOrDefault();
                var flags = m.Flags ?? MessageFlags.None;
                return new SupportMailSummary(
                    m.UniqueId.Id,
                    from?.Address ?? "",
                    from?.Name ?? "",
                    m.Envelope?.To.Mailboxes.Select(x => x.Address).ToList() ?? [],
                    m.Envelope?.Subject ?? "",
                    m.Envelope?.Date ?? DateTimeOffset.MinValue,
                    flags.HasFlag(MessageFlags.Seen),
                    flags.HasFlag(MessageFlags.Flagged),
                    flags.HasFlag(MessageFlags.Answered),
                    m.Attachments.Any(),
                    Trim(m.PreviewText ?? "", PreviewChars));
            })
            .ToList();
        return new SupportMailPage(uids.Count, messages);
    }

    /// <summary>Open one message and mark it read — opening it in the panel is reading it, and
    /// a queue where nothing is ever marked read is a queue nobody can share. A draft is not
    /// "read" by being reopened, so it is left alone.</summary>
    public async Task<SupportMailMessage> GetAsync(string folderId, uint uid, CancellationToken ct = default)
    {
        using var client = await ConnectAsync(ct);
        var folder = Resolve(client, folderId);
        await folder.OpenAsync(FolderAccess.ReadWrite, ct);

        var id = new UniqueId(uid);
        var message = await LoadAsync(folder, id, ct);
        var summary = (await folder.FetchAsync([id], MessageSummaryItems.Flags, ct)).FirstOrDefault();
        var flags = summary?.Flags ?? MessageFlags.None;
        if (folderId != "drafts" && !flags.HasFlag(MessageFlags.Seen))
            await folder.AddFlagsAsync(id, MessageFlags.Seen, true, ct);

        string? html = null;
        var remote = false;
        if (!string.IsNullOrEmpty(message.HtmlBody))
            (html, remote) = RenderHtml(message.HtmlBody, message);
        var text = message.TextBody ?? (message.HtmlBody is null ? "" : StripHtml(message.HtmlBody));

        var from = message.From.Mailboxes.FirstOrDefault();
        var files = Files(message);
        return new SupportMailMessage(
            uid, folderId, from?.Address ?? "", from?.Name ?? "",
            message.To.Mailboxes.Select(x => x.Address).ToList(),
            message.Cc.Mailboxes.Select(x => x.Address).ToList(),
            message.ReplyTo.Mailboxes.FirstOrDefault()?.Address,
            message.Subject ?? "", message.Date, Trim(text, MaxBodyChars), html, remote,
            files.Select((f, i) => new SupportMailAttachment(i, FileNameOf(f, i), MimeOf(f), SizeOf(f))).ToList(),
            flags.HasFlag(MessageFlags.Flagged),
            folderId == "drafts" || flags.HasFlag(MessageFlags.Draft));
    }

    public async Task<SupportMailFile> GetAttachmentAsync(string folderId, uint uid, int index, CancellationToken ct = default)
    {
        using var client = await ConnectAsync(ct);
        var folder = Resolve(client, folderId);
        await folder.OpenAsync(FolderAccess.ReadOnly, ct);
        var message = await LoadAsync(folder, new UniqueId(uid), ct);
        var files = Files(message);
        if (index < 0 || index >= files.Count) throw DomainException.NotFound("attachment not found");
        return ToFile(files[index], index);
    }

    /// <summary>Read / unread, starred / not. Either may be left null to keep it as it is.</summary>
    public async Task SetFlagsAsync(string folderId, IReadOnlyList<uint> uids, bool? seen, bool? flagged, CancellationToken ct = default)
    {
        if (uids.Count == 0) return;
        using var client = await ConnectAsync(ct);
        var folder = Resolve(client, folderId);
        await folder.OpenAsync(FolderAccess.ReadWrite, ct);
        var ids = Ids(uids);
        if (seen is { } s)
        {
            if (s) await folder.AddFlagsAsync(ids, MessageFlags.Seen, true, ct);
            else await folder.RemoveFlagsAsync(ids, MessageFlags.Seen, true, ct);
        }
        if (flagged is { } f)
        {
            if (f) await folder.AddFlagsAsync(ids, MessageFlags.Flagged, true, ct);
            else await folder.RemoveFlagsAsync(ids, MessageFlags.Flagged, true, ct);
        }
    }

    /// <summary>Move to another folder. Into Junk teaches the spam filter "spam", out of Junk
    /// "not spam" (the mail server's RSPAMD_LEARN). A message moved to Junk is also marked read:
    /// nobody needs a badge counting the spam.</summary>
    public async Task MoveAsync(string folderId, IReadOnlyList<uint> uids, string toId, CancellationToken ct = default)
    {
        if (uids.Count == 0 || folderId == toId) return;
        using var client = await ConnectAsync(ct);
        var folder = Resolve(client, folderId);
        var target = Resolve(client, toId);
        await folder.OpenAsync(FolderAccess.ReadWrite, ct);
        var ids = Ids(uids);
        if (toId == "junk") await folder.AddFlagsAsync(ids, MessageFlags.Seen, true, ct);
        await folder.MoveToAsync(ids, target, ct);
    }

    /// <summary>Delete as a mail client does: to Trash, and from Trash for good.</summary>
    public async Task DeleteAsync(string folderId, IReadOnlyList<uint> uids, CancellationToken ct = default)
    {
        if (uids.Count == 0) return;
        if (folderId != "trash")
        {
            await MoveAsync(folderId, uids, "trash", ct);
            return;
        }
        using var client = await ConnectAsync(ct);
        var folder = Resolve(client, folderId);
        await folder.OpenAsync(FolderAccess.ReadWrite, ct);
        await Expunge(folder, Ids(uids), ct);
    }

    /// <summary>"Empty Trash" / "Empty Spam": everything in the folder, for good.</summary>
    public async Task EmptyAsync(string folderId, CancellationToken ct = default)
    {
        if (folderId is not ("trash" or "junk"))
            throw DomainException.InvalidInput("only Trash and Spam can be emptied");
        using var client = await ConnectAsync(ct);
        var folder = Resolve(client, folderId);
        await folder.OpenAsync(FolderAccess.ReadWrite, ct);
        var all = await folder.SearchAsync(SearchQuery.All, ct);
        if (all.Count > 0) await Expunge(folder, all, ct);
    }

    /// <summary>Send as the mailbox itself: threaded when it answers something, carrying the
    /// files of a forwarded message or of the draft it came from; then a copy in Sent, the
    /// original marked answered, and the draft gone.</summary>
    public async Task SendAsync(SupportMailOutgoing m, CancellationToken ct = default)
    {
        var (to, cc) = Recipients(m);
        if (to.Count + cc.Count == 0) throw DomainException.InvalidInput("add at least one recipient");

        using var imap = await ConnectAsync(ct);
        var message = await BuildAsync(imap, m, to, cc, ct);

        using (var smtp = new SmtpClient())
        {
            Prepare(smtp);
            var host = string.IsNullOrWhiteSpace(_opt.SmtpHost) ? _opt.Host : _opt.SmtpHost;
            try
            {
                await smtp.ConnectAsync(host, _opt.SmtpPort,
                    _opt.SmtpPort == 587 ? MailKit.Security.SecureSocketOptions.StartTls
                                         : MailKit.Security.SecureSocketOptions.SslOnConnect, ct);
                await smtp.AuthenticateAsync(_opt.Username, _opt.Password, ct);
                await smtp.SendAsync(message, ct);
                await smtp.DisconnectAsync(true, ct);
            }
            catch (SmtpCommandException e)
            {
                // A recipient or the message refused by the server: the administrator's to fix.
                throw DomainException.InvalidInput($"the mail server refused the message: {e.Message}");
            }
            catch (Exception e) when (e is not OperationCanceledException and not DomainException)
            {
                throw Unreachable(e, "SMTP");
            }
        }

        // Sent, answered, draft gone. None of it un-sends the message, so a failure here is
        // logged rather than reported as a failed send — the person would only send it again.
        try
        {
            await Resolve(imap, "sent").AppendAsync(new AppendRequest(message, MessageFlags.Seen), ct);
            if (m.ReplyFolder is { } rf && m.ReplyUid is { } ru)
            {
                var original = Resolve(imap, rf);
                await original.OpenAsync(FolderAccess.ReadWrite, ct);
                await original.AddFlagsAsync(new UniqueId(ru), MessageFlags.Answered, true, ct);
            }
            if (m.DraftUid is { } du)
            {
                var drafts = Resolve(imap, "drafts");
                await drafts.OpenAsync(FolderAccess.ReadWrite, ct);
                await Expunge(drafts, [new UniqueId(du)], ct);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "support mail: sent, but filing it (Sent/answered/draft) failed");
        }
        log.LogInformation("support mail: sent to {Count} recipient(s)", to.Count + cc.Count);
    }

    /// <summary>Keep the message in Drafts, replacing the earlier version of the same draft.
    /// Returns the new draft's uid (UIDPLUS), so the next save replaces this one.</summary>
    public async Task<uint?> SaveDraftAsync(SupportMailOutgoing m, CancellationToken ct = default)
    {
        var (to, cc) = Recipients(m);
        using var imap = await ConnectAsync(ct);
        var message = await BuildAsync(imap, m, to, cc, ct);
        var drafts = Resolve(imap, "drafts");
        var uid = await drafts.AppendAsync(new AppendRequest(message, MessageFlags.Seen | MessageFlags.Draft), ct);
        if (m.DraftUid is { } old)
        {
            await drafts.OpenAsync(FolderAccess.ReadWrite, ct);
            await Expunge(drafts, [new UniqueId(old)], ct);
        }
        return uid?.Id;
    }

    // ── building a message ──────────────────────────────────────────────────────────────

    private static (List<MailboxAddress> To, List<MailboxAddress> Cc) Recipients(SupportMailOutgoing m)
    {
        static List<MailboxAddress> Parse(IEnumerable<string> raw)
        {
            var list = new List<MailboxAddress>();
            foreach (var r in raw.SelectMany(x => x.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)))
            {
                if (!MailboxAddress.TryParse(r, out var a) || !a.Address.Contains('@'))
                    throw DomainException.InvalidInput($"not an e-mail address: {r}");
                list.Add(a);
            }
            return list;
        }
        var to = Parse(m.To);
        var cc = Parse(m.Cc);
        if (to.Count + cc.Count > MaxRecipients)
            throw DomainException.InvalidInput($"at most {MaxRecipients} recipients");
        return (to, cc);
    }

    private async Task<MimeMessage> BuildAsync(ImapClient imap, SupportMailOutgoing m,
        List<MailboxAddress> to, List<MailboxAddress> cc, CancellationToken ct)
    {
        if (m.Subject.Length > 500) throw DomainException.InvalidInput("the subject is too long");
        if (m.Text.Length > MaxBodyChars) throw DomainException.InvalidInput("the text is too long");

        var message = new MimeMessage();
        message.From.Add(new MailboxAddress(_opt.FromName, Address));
        message.To.AddRange(to);
        message.Cc.AddRange(cc);
        message.Subject = m.Subject;
        message.Date = DateTimeOffset.Now;

        // Threading: In-Reply-To alone is enough for most clients, References is what keeps a
        // long conversation in one thread. Without them the answer arrives as a new message and
        // the person has to work out what it is about.
        if (m.ReplyFolder is { } rf && m.ReplyUid is { } ru)
        {
            var folder = Resolve(imap, rf);
            await folder.OpenAsync(FolderAccess.ReadOnly, ct);
            var original = await LoadAsync(folder, new UniqueId(ru), ct);
            if (!string.IsNullOrEmpty(original.MessageId))
            {
                message.InReplyTo = original.MessageId;
                foreach (var r in original.References) message.References.Add(r);
                message.References.Add(original.MessageId);
            }
        }

        var builder = new BodyBuilder { TextBody = m.Text };
        long total = 0;
        void Add(SupportMailFile f)
        {
            total += f.Data.LongLength;
            if (total > MaxOutgoingFileBytes)
                throw DomainException.TooLarge($"attachments may add up to {MaxOutgoingFileBytes / 1024 / 1024} MB");
            var type = ContentType.TryParse(f.Mime, out var parsed) ? parsed : new ContentType("application", "octet-stream");
            builder.Attachments.Add(f.FileName, f.Data, type);
        }
        // Files of messages already in the mailbox, grouped so each message is fetched once.
        foreach (var group in m.Keep.GroupBy(k => (k.Folder, k.Uid)))
        {
            var folder = Resolve(imap, group.Key.Folder);
            await folder.OpenAsync(FolderAccess.ReadOnly, ct);
            var source = await LoadAsync(folder, new UniqueId(group.Key.Uid), ct);
            var files = Files(source);
            foreach (var k in group)
            {
                if (k.Index < 0 || k.Index >= files.Count) throw DomainException.NotFound("attachment not found");
                Add(ToFile(files[k.Index], k.Index));
            }
        }
        foreach (var f in m.Files) Add(f);
        message.Body = builder.ToMessageBody();
        return message;
    }

    // ── reading a message ───────────────────────────────────────────────────────────────

    private static async Task<MimeMessage> LoadAsync(IMailFolder folder, UniqueId id, CancellationToken ct)
    {
        try
        {
            return await folder.GetMessageAsync(id, ct);
        }
        catch (MessageNotFoundException)
        {
            throw DomainException.NotFound("message not found");
        }
    }

    /// <summary>The files of a message, in a stable order: real attachments, then inline parts
    /// that are not text and are not shown inside the HTML (an inline cid: picture is part of
    /// the letter, not a file).</summary>
    private static List<MimeEntity> Files(MimeMessage message)
    {
        var html = message.HtmlBody ?? "";
        var files = message.Attachments.ToList();
        foreach (var part in message.BodyParts.OfType<MimePart>())
        {
            if (files.Contains(part) || part.ContentType.IsMimeType("text", "*")) continue;
            var cid = part.ContentId;
            if (!string.IsNullOrEmpty(cid) && html.Contains("cid:" + cid, StringComparison.OrdinalIgnoreCase)) continue;
            files.Add(part);
        }
        return files;
    }

    private static string FileNameOf(MimeEntity e, int index) => e switch
    {
        MimePart p when !string.IsNullOrWhiteSpace(p.FileName) => p.FileName,
        MessagePart mp => (mp.Message?.Subject is { Length: > 0 } s ? s : "message") + ".eml",
        _ => $"attachment-{index + 1}",
    };

    private static string MimeOf(MimeEntity e) => e is MessagePart ? "message/rfc822" : e.ContentType.MimeType;

    private static long SizeOf(MimeEntity e)
    {
        using var counter = new MemoryStream();
        Decode(e, counter);
        return counter.Length;
    }

    private static void Decode(MimeEntity e, Stream to)
    {
        switch (e)
        {
            case MimePart p when p.Content is not null:
                p.Content.DecodeTo(to);
                break;
            case MessagePart mp when mp.Message is not null:
                mp.Message.WriteTo(to);
                break;
        }
    }

    private static SupportMailFile ToFile(MimeEntity e, int index)
    {
        using var buffer = new MemoryStream();
        Decode(e, buffer);
        return new SupportMailFile(FileNameOf(e, index), MimeOf(e), buffer.ToArray());
    }

    private static readonly HtmlSanitizer Sanitizer = BuildSanitizer();

    private static HtmlSanitizer BuildSanitizer()
    {
        var s = new HtmlSanitizer();
        // Newsletters live on a <style> block in <head>; its CSS is sanitised like inline style.
        s.AllowedTags.Add("style");
        // The library keeps form controls by default. A letter has no business asking for a
        // password inside our admin panel, even in a frame that could not submit it anywhere.
        foreach (var t in new[] { "form", "input", "button", "select", "option", "optgroup", "textarea",
                     "label", "fieldset", "legend", "datalist", "output" })
            s.AllowedTags.Remove(t);
        foreach (var a in new[] { "class", "bgcolor", "background", "align", "valign", "border",
                     "cellpadding", "cellspacing", "width", "height", "color", "face", "size" })
            s.AllowedAttributes.Add(a);
        s.AllowedSchemes.Add("mailto");
        s.AllowedSchemes.Add("data"); // inline pictures, turned from cid: below
        s.PostProcessNode += (_, e) =>
        {
            if (e.Node is AngleSharp.Dom.IElement { LocalName: "a" } link)
            {
                // A link opens outside the frame, and tells the site nothing about where it was.
                link.SetAttribute("target", "_blank");
                link.SetAttribute("rel", "noopener noreferrer");
            }
        };
        return s;
    }

    private static readonly Regex RemoteRef = new(
        @"(?:src|background)\s*=\s*[""']?\s*(?:https?:)?//|url\(\s*[""']?\s*(?:https?:)?//",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Sanitised HTML with its cid: pictures inlined, and whether it still points at
    /// anything remote.</summary>
    private static (string Html, bool Remote) RenderHtml(string html, MimeMessage message)
    {
        foreach (var part in message.BodyParts.OfType<MimePart>())
        {
            if (string.IsNullOrEmpty(part.ContentId) || !part.ContentType.IsMimeType("image", "*")) continue;
            var reference = "cid:" + part.ContentId;
            if (!html.Contains(reference, StringComparison.OrdinalIgnoreCase)) continue;
            using var data = new MemoryStream();
            part.Content?.DecodeTo(data);
            if (data.Length == 0 || data.Length > MaxInlineImageBytes) continue;
            var uri = $"data:{part.ContentType.MimeType};base64,{Convert.ToBase64String(data.ToArray())}";
            html = Regex.Replace(html, Regex.Escape(reference), uri, RegexOptions.IgnoreCase);
        }
        var clean = Sanitizer.SanitizeDocument(html);
        return (clean, RemoteRef.IsMatch(clean));
    }

    // ── IMAP plumbing ───────────────────────────────────────────────────────────────────

    private static IList<UniqueId> Ids(IEnumerable<uint> uids) => uids.Select(u => new UniqueId(u)).ToList();

    private static async Task Expunge(IMailFolder folder, IList<UniqueId> ids, CancellationToken ct)
    {
        await folder.AddFlagsAsync(ids, MessageFlags.Deleted, true, ct);
        await folder.ExpungeAsync(ids, ct);
    }

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    /// <summary>Tags out, entities decoded, whitespace collapsed. Only for the TEXT version of an
    /// HTML-only message (a reply's quote, the plain view) — never rendered as markup.</summary>
    private static string StripHtml(string html)
    {
        var text = Regex.Replace(html, "<(script|style)[^>]*>.*?</\\1>", " ",
            RegexOptions.Singleline | RegexOptions.IgnoreCase);
        text = Regex.Replace(text, "<br\\s*/?>|</p>|</div>|</tr>", "\n", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, "<[^>]+>", "");
        text = System.Net.WebUtility.HtmlDecode(text);
        text = Regex.Replace(text, "[ \\t]{2,}", " ");
        return Regex.Replace(text, "\\n{3,}", "\n\n").Trim();
    }
}
