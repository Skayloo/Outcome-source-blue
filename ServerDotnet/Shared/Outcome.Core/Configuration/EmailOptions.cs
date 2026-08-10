namespace Outcome.Infrastructure.Configuration;

/// <summary>SMTP settings, bound from the <c>Email</c> config section (overridable via
/// <c>OUTCOME_Email__Host</c> etc.). Leave <see cref="Host"/> empty to disable real sending —
/// messages are then written to the log so 2FA codes can be read during testing.</summary>
public sealed class EmailOptions
{
    public string Host { get; set; } = "";
    public int Port { get; set; } = 587;
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public string From { get; set; } = "no-reply@outcome.local";
    public string FromName { get; set; } = "Outcome";
    public bool UseSsl { get; set; } = true;
}
