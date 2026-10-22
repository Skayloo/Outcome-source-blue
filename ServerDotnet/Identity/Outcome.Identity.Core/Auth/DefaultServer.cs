namespace Outcome.Application.Auth;

/// <summary>
/// The server a new account gets when it arrives in no server at all — open registration.
/// Without one the app opened on an empty page (the owner, 2026-10-16). The
/// newcomer owns it, it is made like any other (#general and the "General" voice room) and it
/// counts towards the servers they may own. An invite or a space's own domain already puts the
/// newcomer in a server; then nothing is made.
/// </summary>
internal static class DefaultServer
{
    // Usernames are at most 32 characters (AuthRules), server names at most 64 (ServerEndpoints).
    public static string NameFor(string? username) =>
        $"{(string.IsNullOrWhiteSpace(username) ? "My" : username.Trim())} Server";
}
