using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Outcome.Application.Common;

/// <summary>Strips all HTML tags from user input (equivalent to bluemonday StrictPolicy).</summary>
public static partial class TextSanitizer
{
    [GeneratedRegex("<[^>]*>")]
    private static partial Regex TagRegex();

    public static string StripHtml(string? input) => TagRegex().Replace(input ?? string.Empty, string.Empty).Trim();
}

/// <summary>Username/password/setting validation ported from Server/auth.</summary>
public static class AuthRules
{
    /// <summary>Returns an error message, or null if the username is valid (2–32 chars, no control/format chars).</summary>
    public static string? ValidateUsername(string username)
    {
        username = (username ?? string.Empty).Trim();
        var n = username.Length;
        if (n < 2) return "username must be at least 2 characters";
        if (n > 32) return "username must be at most 32 characters";
        foreach (var r in username)
        {
            if (char.IsControl(r)) return "username must not contain control characters";
            if (char.GetUnicodeCategory(r) == UnicodeCategory.Format) return "username must not contain invisible characters";
        }
        return null;
    }

    /// <summary>Returns an error message, or null if the email looks valid.</summary>
    public static string? ValidateEmail(string email)
    {
        email = (email ?? string.Empty).Trim();
        if (email.Length == 0) return "email is required";
        if (email.Length > 254) return "email is too long";
        if (email.Contains(' ')) return "enter a valid email address";
        var at = email.IndexOf('@');
        if (at <= 0 || at != email.LastIndexOf('@') || at == email.Length - 1)
            return "enter a valid email address";
        var domain = email[(at + 1)..];
        if (!domain.Contains('.') || domain.StartsWith('.') || domain.EndsWith('.'))
            return "enter a valid email address";
        return null;
    }

    /// <summary>Returns an error message, or null if the password is valid: 8–72 bytes and
    /// containing at least one uppercase letter, one lowercase letter and one digit.</summary>
    public static string? ValidatePassword(string password)
    {
        password ??= string.Empty;
        var bytes = Encoding.UTF8.GetByteCount(password);
        if (bytes < 8) return "password must be at least 8 characters";
        if (bytes > 72) return "password must not exceed 72 characters";
        if (!password.Any(char.IsUpper)) return "password must contain an uppercase letter";
        if (!password.Any(char.IsLower)) return "password must contain a lowercase letter";
        if (!password.Any(char.IsDigit)) return "password must contain a digit";
        return null;
    }

    public static bool ParseBoolean(string? value, bool fallback) =>
        (value ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "1" or "true" => true,
            "0" or "false" => false,
            _ => fallback,
        };
}
