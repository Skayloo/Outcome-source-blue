namespace Outcome.Infrastructure.Media;

/// <summary>
/// A short video turned into an animated WebP for the GIF reaction library. What Telegram, iMessage
/// and most sites call a "GIF" is an MP4 (H.264, no sound); saved to disk it is .mp4 or .mov, and the
/// library — drawn as a picture in every client and on the guest page — only takes pictures (the
/// owner, 2026-10-28: "нужно добавить поддержку mov и mp4"). A reaction is shown for 5 s, so the first
/// 10 s are kept, at most 480 px a side, 15 frames a second, no sound; a result over the library's
/// limit is made again, smaller.
/// </summary>
public static class ReactionAnimator
{
    /// <summary>MP4/MOV (the mov demuxer) and WebM/Matroska — nothing else is opened.</summary>
    public const string VideoFormats = "mov,matroska";

    private static readonly (int Side, int Fps, int Quality)[] Attempts = [(480, 15, 75), (320, 12, 60), (240, 10, 45)];

    /// <summary>A temporary animated WebP made from <paramref name="input"/> no larger than
    /// <paramref name="maxBytes"/>, or null when ffmpeg is missing, refuses the file, or cannot get it
    /// that small. The caller deletes the file.</summary>
    public static async Task<string?> ToWebpAsync(string input, long maxBytes, CancellationToken ct)
    {
        var guard = MediaProcess.InputGuard(VideoFormats);
        foreach (var (side, fps, quality) in Attempts)
        {
            var output = Path.Combine(Path.GetTempPath(), $"gif_{Guid.NewGuid():N}.webp");
            var args = $"-nostdin -v error -nostats -y {guard} -t 10 -i \"{input}\" -an "
                + $"-vf \"fps={fps},scale='min({side},iw)':'min({side},ih)':force_original_aspect_ratio=decrease:flags=lanczos\" "
                + $"-loop 0 -c:v libwebp_anim -quality {quality} -compression_level 4 -f webp \"{output}\"";
            var r = await MediaProcess.RunAsync("ffmpeg", args, TimeSpan.FromSeconds(60), captureStdout: false, ct);
            ct.ThrowIfCancellationRequested();
            var info = new FileInfo(output);
            var made = r is { ExitCode: 0 } && info.Exists && info.Length > 0;
            if (made && info.Length <= maxBytes) return output;
            TryDelete(output);
            // Not a size problem — a smaller attempt would fail the same way.
            if (!made) return null;
        }
        return null;
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* temp file — the OS cleans up */ }
    }
}
