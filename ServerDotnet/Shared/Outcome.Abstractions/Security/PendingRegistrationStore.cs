namespace Outcome.Shared.Abstractions.Security;

/// <summary>A registration waiting for its email code. The password is stored as the FINAL
/// Identity hash (never raw) — completion writes it onto the new user verbatim, so the
/// plaintext never touches the store. The invite is validated up front but consumed only
/// on completion.</summary>
public sealed record PendingRegistration(
    string Email, string Username, string PasswordHash, string InviteCode,
    string? Device, string Ip, string Code,
    // Carried from the form that started this flow, so the account records the text the person
    // actually saw rather than whatever is published by the time they type the emailed code.
    string? ConsentVersion = null);

/// <summary>
/// Short-lived store of registrations awaiting email verification (TTL 10 min, 5-attempt
/// budget — same contract as the 2FA challenge store). Registration is the anti-abuse
/// chokepoint: nothing touches the users table until the code round-trips, so a bot
/// without a real inbox never creates a row. Redis-backed when replicated (the register
/// and verify calls may land on different replicas).
/// </summary>
public interface IPendingRegistrationStore
{
    /// <summary>Park a validated registration; returns the opaque token the client echoes back.</summary>
    string Issue(PendingRegistration reg);

    PendingRegistration? Lookup(string token);

    /// <summary>Remove and return — call only after the code matched.</summary>
    PendingRegistration? Consume(string token);

    /// <summary>Count a wrong code; the entry self-destructs at <paramref name="maxFailures"/>.</summary>
    void RegisterFailure(string token, int maxFailures);
}
