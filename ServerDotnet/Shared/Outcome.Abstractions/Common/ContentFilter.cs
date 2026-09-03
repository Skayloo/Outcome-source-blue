using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Outcome.Application.Common;

/// <summary>
/// Refuses messages carrying terms nobody has a legitimate reason to send.
///
/// App Review guideline 1.2 requires "a method for filtering objectionable content" from any
/// app carrying user-generated content, and frontend/public/terms.html promises one. This is
/// it. It is deliberately narrow: a list wide enough to catch ordinary rudeness would refuse
/// half of what people actually say to each other, and a chat that argues with its users about
/// wording is a worse product than one that lets a moderator handle the rest. Reporting and
/// blocking cover what a word list cannot.
///
/// WHAT IT CANNOT SEE. Direct messages on a red server are end-to-end encrypted — the server
/// holds ciphertext and could not read them if it wanted to. Filtering therefore applies to
/// server channels, which are plaintext, and the honest description of the guarantee is
/// "checked wherever the content is legible to us". Reporting works everywhere, because the
/// reporter sends the text they can see.
///
/// EVASION. Matching is done on a folded form of the message: case dropped, diacritics
/// stripped, the usual letter/digit swaps undone, and runs of repeated characters collapsed.
/// This is not a serious defence against a determined person and is not meant to be — it is
/// meant to stop the lazy spelling that would otherwise make the list decorative.
/// </summary>
public static partial class ContentFilter
{
    /// <summary>
    /// Terms that get a message refused. Kept short and specific on purpose: every entry here
    /// is something with no ordinary use in conversation. Do not add slurs' near-homographs or
    /// common profanity — the false positives cost more than they save, and they are what
    /// reporting exists for.
    /// </summary>
    private static readonly string[] Prohibited =
    [
        // Child sexual abuse material — the category Apple names first and the one that must
        // never rely on a moderator getting to the queue in time.
        "childporn", "childpornography", "cp4sale", "pedoporn",
        "детскоепорно", "детпорно",
        // Solicitation of minors.
        "loli hentai", "lolicon", "shotacon",
        // Explicit non-consensual material.
        "rapevideo", "revengeporn",
        // Trade in the above.
        "cpselling", "cptrade",
    ];

    [GeneratedRegex(@"[^\p{L}\p{N}]+")]
    private static partial Regex NonAlphanumeric();

    [GeneratedRegex(@"(.)\1{2,}")]
    private static partial Regex Repeats();

    /// <summary>
    /// The term this text trips on, or null when it is clean.
    ///
    /// Returns WHICH term matched rather than a bool so the refusal can be recorded for the
    /// moderators without them having to guess what the filter objected to.
    /// </summary>
    public static string? FirstProhibited(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var folded = Fold(text);
        if (folded.Length == 0) return null;
        foreach (var term in Prohibited)
        {
            var needle = Fold(term);
            if (needle.Length > 0 && folded.Contains(needle, StringComparison.Ordinal)) return term;
        }
        return null;
    }

    public static bool IsClean(string? text) => FirstProhibited(text) is null;

    /// <summary>
    /// Lower-case, without diacritics, without separators, with the common digit-for-letter
    /// swaps undone and long runs collapsed. "P.E.D.O—P0RN" and "pedoporn" fold to the same
    /// string; that is the whole trick.
    /// </summary>
    private static string Fold(string text)
    {
        var lowered = text.ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(lowered.Length);
        foreach (var ch in lowered)
        {
            // Combining marks are what FormD split off; dropping them turns "ё" into "е".
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(ch switch
            {
                '0' => 'o', '1' => 'i', '3' => 'e', '4' => 'a', '5' => 's', '7' => 't', '@' => 'a', '$' => 's',
                _ => ch,
            });
        }
        var collapsed = Repeats().Replace(sb.ToString(), "$1");
        return NonAlphanumeric().Replace(collapsed, string.Empty);
    }
}
