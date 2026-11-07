using Microsoft.AspNetCore.Identity;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Application.Auth;

/// <summary>
/// The server's half of sign-in without the password (see <see cref="LoginKeys"/>): checking a
/// login key, storing a newly set credential, moving an account made before login v2. Every
/// endpoint that takes or sets a password goes through here, so there is one place that decides.
/// </summary>
public static class LoginKeyAuth
{
    /// <summary>
    /// Stores a password the client just set. The hash of the raw password goes with it: a password
    /// set this way never reached the server, so an older server put back could not check it
    /// anyway — and an old hash left beside a new password would still open the account there.
    /// The caller saves the user.
    /// </summary>
    public static void Set(User user, LoginKeys.Valid credential, IPasswordHasher<User> hasher)
    {
        user.AuthSalt = credential.Salt;
        user.AuthIterations = credential.Iterations;
        user.AuthHash = hasher.HashPassword(user, credential.Key);
        user.PasswordHash = null;
        // What Identity's own password change does; harmless if nothing reads it.
        user.SecurityStamp = Guid.NewGuid().ToString("N");
    }

    /// <summary>
    /// Does this login key open the account? Re-hashes the stored key when the server's Argon2
    /// settings moved on (the caller saves the user when this returns true). False for an account
    /// that has not moved to login v2 yet — the client moves it first (<see cref="TryMove"/>).
    /// </summary>
    public static bool Verify(User user, string? loginKey, IPasswordHasher<User> hasher)
    {
        if (user.AuthHash is null) return false;
        var key = LoginKeys.NormalizeKey(loginKey);
        if (key is null) return false;
        var result = hasher.VerifyHashedPassword(user, user.AuthHash, key);
        if (result == PasswordVerificationResult.SuccessRehashNeeded)
            user.AuthHash = hasher.HashPassword(user, key);
        return result != PasswordVerificationResult.Failed;
    }

    /// <summary>
    /// Moves an account made before login v2: the client computed the stored hash of the password
    /// on the device (<paramref name="legacyProof"/>) and sent a fresh credential with it. The old
    /// hash STAYS, so an older server put back still signs the account in with its password.
    /// False when the proof does not match or the account already moved. The caller saves the user.
    /// </summary>
    public static bool TryMove(User user, string? legacyProof, LoginKeys.Valid credential, IPasswordHasher<User> hasher)
    {
        if (user.AuthHash is not null || string.IsNullOrEmpty(legacyProof)) return false;
        if (!LoginKeys.LegacyProofMatches(user.PasswordHash, legacyProof)) return false;
        user.AuthSalt = credential.Salt;
        user.AuthIterations = credential.Iterations;
        user.AuthHash = hasher.HashPassword(user, credential.Key);
        return true;
    }

    // ── a credential waiting for the second factor (password reset on a 2FA account) ──────────

    /// <summary>Packs a set credential for the 2FA step: "salt:iterations:hash". None of the three
    /// contains ':' (base64, digits, a PHC string).</summary>
    public static string PackPending(LoginKeys.Valid credential, IPasswordHasher<User> hasher, User user) =>
        $"{credential.Salt}:{credential.Iterations}:{hasher.HashPassword(user, credential.Key)}";

    /// <summary>Applies a packed credential. False for anything else — a challenge parked by a
    /// server from before login v2 holds a bare password hash: that reset starts over.</summary>
    public static bool ApplyPending(User user, string packed)
    {
        var parts = packed.Split(':');
        if (parts.Length != 3 || !int.TryParse(parts[1], out var iterations)) return false;
        user.AuthSalt = parts[0];
        user.AuthIterations = iterations;
        user.AuthHash = parts[2];
        user.PasswordHash = null;
        user.SecurityStamp = Guid.NewGuid().ToString("N");
        return true;
    }
}
