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
    /// Does the client's proof open an account made before login v2? The client computed the old
    /// hash of the password on the device (<paramref name="legacyProof"/>). Against a wrapped old
    /// hash (<see cref="LoginKeys.WrapPrefix"/>) the proof is hashed again and compared with the
    /// wrap, so the stored value itself is no proof. False for an account that already moved.
    /// Changes nothing: a sign-in still waiting for its second factor must not move the account.
    /// </summary>
    public static bool LegacyMatches(User user, string? legacyProof, IPasswordHasher<User> hasher)
    {
        if (user.AuthHash is not null || string.IsNullOrEmpty(legacyProof)) return false;
        if (LoginKeys.Unwrap(user.PasswordHash) is { } wrap)
        {
            if (LoginKeys.DescribeLegacy(user.PasswordHash).Kind == "unsupported") return false;
            var proof = LoginKeys.DecodeProof(legacyProof, wrap.Length);
            return proof is not null
                   && hasher.VerifyHashedPassword(user, wrap.WrapPhc, Convert.ToBase64String(proof)) != PasswordVerificationResult.Failed;
        }
        return LoginKeys.LegacyProofMatches(user.PasswordHash, legacyProof);
    }

    /// <summary>
    /// Moves an account made before login v2 at once (a signed-in session confirming its password):
    /// the proof, then the fresh credential the client sent with it. The old hash goes, as with any
    /// password set the new way. False when the proof does not match or the account already moved.
    /// The caller saves the user.
    /// </summary>
    public static bool TryMove(User user, string? legacyProof, LoginKeys.Valid credential, IPasswordHasher<User> hasher)
    {
        if (!LegacyMatches(user, legacyProof, hasher)) return false;
        Set(user, credential, hasher);
        return true;
    }

    /// <summary>
    /// The wrapped form of the account's plain old hash (<see cref="LoginKeys.WrapLegacy"/>), or
    /// null when there is nothing to wrap.
    /// </summary>
    public static string? WrapStored(User user, IPasswordHasher<User> hasher)
    {
        var old = LoginKeys.LegacyHashBytes(user.PasswordHash);
        return old is null ? null
            : LoginKeys.WrapLegacy(user.PasswordHash, hasher.HashPassword(user, Convert.ToBase64String(old)));
    }

    /// <summary>
    /// Applies a move parked until the second factor (<see cref="PackPending"/>). True when the
    /// account has a login key afterwards — also when another device moved it meanwhile, whose
    /// credential then stays. The caller saves the user when it had none before.
    /// </summary>
    public static bool ApplyPendingMove(User user, string packed) =>
        user.AuthHash is not null || ApplyPending(user, packed);

    // ── a credential waiting for the second factor (a password reset or a move on a 2FA account) ──

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
