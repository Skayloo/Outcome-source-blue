using System.Net.Mail;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Outcome.Domain.Errors;
using Outcome.Infrastructure.Configuration;
using Outcome.Infrastructure.Tenancy;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Api.Endpoints;

/// <summary>
/// The landing page's "Написать нам" form.
///
/// <para>The button used to be a <c>mailto:</c> link. On a computer with no mail program set up —
/// which is most of them: people read their mail in a browser — clicking it does nothing at all,
/// and the owner found out from the absence of orders (2026-10-11). Now the page posts here and
/// the request is mailed to the support mailbox, where the admin panel shows it and answers it.</para>
///
/// <para>Nothing is stored: the mailbox is the record. It works without JavaScript too — the page
/// is required to work dead (PRODUCT.md) — so a plain form post is answered with a redirect back
/// to the page, and a script's JSON post with a status code.</para>
///
/// <para>Not a relay: the recipient is fixed by configuration, never taken from the request, and
/// the sender's address only ever becomes the Reply-To.</para>
/// </summary>
public static class ContactEndpoints
{
    public sealed record ContactBody(
        string? Name, string? Contact, string? Company, string? Message, bool? Consent, string? Website);

    public static void MapContactEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/contact", async (HttpContext ctx, ICurrentSpace space, IRateLimiter limiter,
            IEmailSender email, IOptions<EmailOptions> emailOpt, IOptions<SupportMailOptions> supportOpt,
            IOptions<ContactOptions> contactOpt, ILoggerFactory logs, CancellationToken ct) =>
        {
            var form = ctx.Request.HasFormContentType;
            try
            {
                var body = await ReadAsync(ctx, form, ct);
                await SubmitAsync(body, ctx, space.Space, limiter, email, emailOpt.Value, supportOpt.Value,
                    contactOpt.Value, logs.CreateLogger("Outcome.Api.Contact"), ct);
                return form ? Results.Redirect("/#contact-sent") : Results.NoContent();
            }
            catch (DomainException e) when (form)
            {
                // No script to show the reason to: land on the part of the page that says what to do.
                return Results.Redirect(e.StatusCode == 429 ? "/#contact-later" : "/#contact-failed");
            }
        });
    }

    private static async Task<ContactBody> ReadAsync(HttpContext ctx, bool form, CancellationToken ct)
    {
        if (form)
        {
            var f = await ctx.Request.ReadFormAsync(ct);
            return new ContactBody(f["name"], f["contact"], f["company"], f["message"],
                !string.IsNullOrEmpty(f["consent"]), f["website"]);
        }
        try
        {
            return await ctx.Request.ReadFromJsonAsync<ContactBody>(ct)
                ?? throw DomainException.InvalidInput("пустой запрос");
        }
        catch (JsonException)
        {
            throw DomainException.InvalidInput("не удалось прочитать запрос");
        }
    }

    private static async Task SubmitAsync(ContactBody b, HttpContext ctx, Space space, IRateLimiter limiter,
        IEmailSender email, EmailOptions emailOpt, SupportMailOptions support, ContactOptions contact,
        ILogger log, CancellationToken ct)
    {
        // A tenant's host serves the app, not the landing; there is no form there to post.
        if (!space.IsRoot) throw DomainException.NotFound("not found");

        // The hidden field a person never sees and a form-filling bot always fills: say "sent"
        // and send nothing, so the bot learns nothing worth adjusting.
        if (!string.IsNullOrWhiteSpace(b.Website)) return;

        var name = Clean(b.Name);
        var reach = Clean(b.Contact);
        var company = Clean(b.Company);
        var message = (b.Message ?? "").Trim();
        if (b.Consent != true)
            throw DomainException.InvalidInput("Нужно согласие на обработку данных — без него мы не можем ответить.");
        if (name.Length is 0 or > 100)
            throw DomainException.InvalidInput("Напишите, как к вам обращаться.");
        if (reach.Length is < 3 or > 200)
            throw DomainException.InvalidInput("Оставьте почту, телефон или Telegram — иначе ответить некуда.");
        if (company.Length > 200)
            throw DomainException.InvalidInput("Название компании слишком длинное.");
        if (message.Length is < 5 or > 4000)
            throw DomainException.InvalidInput("Напишите, что нужно, — хотя бы пару слов (до 4000 знаков).");

        // After validation, so a typo does not cost one of the three tries.
        if (!ClientRate.Allow(limiter, ctx, $"contact:{space.Id}", 3, TimeSpan.FromMinutes(10))
            || !limiter.Allow($"contact-all:{space.Id}", 30, TimeSpan.FromHours(1)))
            throw DomainException.RateLimited("Слишком много обращений подряд — попробуйте через несколько минут.");

        var to = FirstNonEmpty(contact.To, support.From, support.Username);
        // With no SMTP the sender only LOGS the message, body and all — a customer's request
        // would be written into the server log and answered "sent". Say it does not work instead.
        if (to.Length == 0 || string.IsNullOrWhiteSpace(emailOpt.Host))
            throw DomainException.Unavailable("Форма сейчас не работает — напишите нам на почту.");

        var replyTo = reach.Contains('@') && !reach.Any(char.IsWhiteSpace)
            && MailAddress.TryCreate(reach, out var address) ? address.Address : null;

        var subject = $"Заявка с сайта — {(company.Length > 0 ? company : name)}";
        if (subject.Length > 150) subject = subject[..150];

        var text = new StringBuilder()
            .AppendLine($"Заявка с формы «Написать нам» на {ctx.Request.Host.Host}.")
            .AppendLine()
            .AppendLine($"Имя: {name}")
            .AppendLine($"Связаться: {reach}")
            .AppendLine($"Компания: {(company.Length > 0 ? company : "—")}")
            .AppendLine()
            .AppendLine(message)
            .AppendLine()
            .AppendLine("—")
            .AppendLine(replyTo is not null
                ? "Ответ на это письмо уйдёт отправителю."
                : "Отправитель оставил не почту — свяжитесь по указанному контакту.")
            .ToString();

        await email.SendAsync(to, subject, text, replyTo, ct);
        log.LogInformation("contact form: request mailed to the support mailbox");
    }

    /// <summary>One line, no control characters: these end up in a mail header (the subject).</summary>
    private static string Clean(string? s) =>
        new string((s ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();

    private static string FirstNonEmpty(params string[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim() ?? "";
}
