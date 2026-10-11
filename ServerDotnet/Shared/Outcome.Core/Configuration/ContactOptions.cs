namespace Outcome.Infrastructure.Configuration;

/// <summary>
/// The landing page's contact form, bound from the <c>Contact</c> section
/// (<c>OUTCOME_Contact__To</c>).
/// </summary>
public sealed class ContactOptions
{
    /// <summary>Where a submitted form is mailed. Empty ⇒ the support mailbox
    /// (<see cref="SupportMailOptions.From"/>, else its <c>Username</c>), which the admin panel
    /// reads and answers from — the message is delivered by our own mail server to itself, so no
    /// outside spam filter decides whether a customer's request is seen. With neither set the
    /// form answers 503 and the page shows the address to write to instead.</summary>
    public string To { get; set; } = "";
}
