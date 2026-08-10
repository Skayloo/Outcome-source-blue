using System.Security.Claims;
using Outcome.Domain.Permissions;

namespace Outcome.Shared.Abstractions.Authorization;

/// <summary>
/// String-claim permission model, mirroring api_mobstra_analytics
/// (<c>Analytics.Core.Application.Authorization.Permissions</c>). Each permission is a claim of
/// type <see cref="ClaimType"/> ("Permissions") whose value is one of these constants. A user's
/// effective permissions = their direct <c>user_claims</c> UNION the <c>role_claims</c> of the
/// role they belong to. <see cref="Administrator"/> bypasses all checks.
/// </summary>
public static class Permissions
{
    public const string ClaimType = "Permissions";

    public const string SendMessages   = nameof(SendMessages);
    public const string ReadMessages   = nameof(ReadMessages);
    public const string AttachFiles    = nameof(AttachFiles);
    public const string AddReactions   = nameof(AddReactions);
    public const string UseSoundboard  = nameof(UseSoundboard);
    public const string ConnectVoice   = nameof(ConnectVoice);
    public const string SpeakVoice     = nameof(SpeakVoice);
    public const string UseVideo       = nameof(UseVideo);
    public const string ShareScreen    = nameof(ShareScreen);
    public const string ManageMessages = nameof(ManageMessages);
    public const string ManageChannels = nameof(ManageChannels);
    public const string KickMembers    = nameof(KickMembers);
    public const string BanMembers     = nameof(BanMembers);
    public const string MuteMembers    = nameof(MuteMembers);
    public const string ManageRoles    = nameof(ManageRoles);
    public const string ManageServer   = nameof(ManageServer);
    public const string ManageInvites  = nameof(ManageInvites);
    public const string ViewAuditLog   = nameof(ViewAuditLog);
    public const string Administrator  = nameof(Administrator);

    /// <summary>Extracts the permission values from a claim set (claims of type "Permissions").</summary>
    public static IEnumerable<string> GetFrom(IEnumerable<Claim> claims) =>
        claims.Where(c => c.Type.Contains(ClaimType)).Select(c => c.Value);

    /// <summary>True if the permission set grants <paramref name="required"/> (or Administrator).</summary>
    public static bool Grants(IEnumerable<string> permissions, string required)
    {
        var set = permissions as ICollection<string> ?? permissions.ToList();
        return set.Contains(Administrator) || set.Contains(required);
    }

    /// <summary>
    /// Applies a per-channel override to a base permission set, Discord-style:
    /// <c>effective = (base \ deny) ∪ allow</c>. Both override sets are claim-name sets
    /// (the claim-based replacement for the old int64 allow/deny bitfields). Null sets are
    /// treated as empty so callers can pass a missing override straight through.
    /// </summary>
    public static IReadOnlySet<string> ApplyOverride(
        IEnumerable<string> baseNames, IEnumerable<string>? allow, IEnumerable<string>? deny)
    {
        var set = new HashSet<string>(baseNames);
        if (deny is not null) set.ExceptWith(deny);
        if (allow is not null) set.UnionWith(allow);
        return set;
    }

    public static readonly string[] All =
    [
        SendMessages, ReadMessages, AttachFiles, AddReactions, UseSoundboard, ConnectVoice,
        SpeakVoice, UseVideo, ShareScreen, ManageMessages, ManageChannels, KickMembers,
        BanMembers, MuteMembers, ManageRoles, ManageServer, ManageInvites, ViewAuditLog, Administrator,
    ];

    /// <summary>Map from permission name to its legacy int64 bit. Lets the claim model stay the
    /// source of truth while the (unchanged) channel-override math and the frontend keep using the
    /// bitfield representation: a role's effective bitfield is derived from its permission claims.</summary>
    private static readonly Dictionary<string, long> Bits = new()
    {
        [SendMessages] = Permission.SendMessages,
        [ReadMessages] = Permission.ReadMessages,
        [AttachFiles] = Permission.AttachFiles,
        [AddReactions] = Permission.AddReactions,
        [UseSoundboard] = Permission.UseSoundboard,
        [ConnectVoice] = Permission.ConnectVoice,
        [SpeakVoice] = Permission.SpeakVoice,
        [UseVideo] = Permission.UseVideo,
        [ShareScreen] = Permission.ShareScreen,
        [ManageMessages] = Permission.ManageMessages,
        [ManageChannels] = Permission.ManageChannels,
        [KickMembers] = Permission.KickMembers,
        [BanMembers] = Permission.BanMembers,
        [MuteMembers] = Permission.MuteMembers,
        [ManageRoles] = Permission.ManageRoles,
        [ManageServer] = Permission.ManageServer,
        [ManageInvites] = Permission.ManageInvites,
        [ViewAuditLog] = Permission.ViewAuditLog,
        [Administrator] = Permission.Administrator,
    };

    /// <summary>Folds a set of permission names into the legacy int64 bitfield.</summary>
    public static long ToBits(IEnumerable<string> names)
    {
        long bits = 0;
        foreach (var n in names)
            if (Bits.TryGetValue(n, out var b)) bits |= b;
        return bits;
    }

    /// <summary>Expands the legacy int64 bitfield back into permission names.</summary>
    public static IReadOnlyList<string> FromBits(long bits)
    {
        var result = new List<string>();
        foreach (var (name, bit) in Bits)
            if ((bits & bit) != 0) result.Add(name);
        return result;
    }
}
