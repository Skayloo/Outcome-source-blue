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
/// EVASION. Matching is done on a folded form of the message: case dropped, diacritics
/// stripped, the usual letter/digit swaps undone, Cyrillic letters that look Latin read as Latin
/// (a Russian "с" in "сptrade" passed until 2026-11-04 — the term and the text fold alike, so a
/// Latin "e" in a Russian word is caught too), and runs of repeated characters collapsed.
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
        // Child sexual abuse material — the category Apple names first and the one that must never wait for a moderator.
        "childporn", "childpornography", "cp4sale", "pedoporn", "kid porn", "kiddie porn",
        "kiddy porn", "preteen porn", "underage porn", "toddler porn", "jailbait", "детскоепорно",
        "детпорно", "детская порнография", "порно с детьми", "порно дети", "порно малолетки",
        "малолетки порно", "педопорно", "чайлд порн", "detskoe porno", "detporno",
        "detskaya pornografiya",
        // Sexualised minors.
        "loli hentai", "lolicon", "shotacon", "lolita porn", "лоликон", "шотакон",
        // Explicit non-consensual material.
        "rapevideo", "revengeporn", "rape porn", "snuff video", "snuff porn", "ревендж порн",
        "слив интим",
        // Trade in the above.
        "cpselling", "cptrade",
        // Selling drugs — a sale or a courier's job, never a drug's name alone, which news and medicine use.
        "работа кладменом", "работа закладчиком", "купить мефедрон", "продам мефедрон",
        "купить амфетамин", "продам амфетамин", "купить кокаин", "продам кокаин", "купить героин",
        "продам героин", "купить гашиш", "продам гашиш", "купить спайс", "продам спайс",
        "купить лсд", "buy cocaine", "cocaine for sale", "meth for sale", "buy crystal meth",
        "buy fentanyl", "fentanyl for sale",
        // Terrorist recruitment and calls to kill — the organisation's name alone still passes: the news uses it.
        "вступай в игил", "вступить в игил", "присоединяйся к игил", "смерть неверным", "join isis",
        "join daesh", "death to infidels", "kill the infidels",
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
                // Cyrillic that looks Latin, upper case included (lowered above).
                'а' => 'a', 'в' => 'b', 'е' => 'e', 'к' => 'k', 'м' => 'm', 'н' => 'h', 'о' => 'o', 'р' => 'p',
                'с' => 'c', 'т' => 't', 'у' => 'y', 'х' => 'x', 'і' => 'i', 'ј' => 'j', 'ѕ' => 's',
                _ => ch,
            });
        }
        var collapsed = Repeats().Replace(sb.ToString(), "$1");
        return NonAlphanumeric().Replace(collapsed, string.Empty);
    }
}
