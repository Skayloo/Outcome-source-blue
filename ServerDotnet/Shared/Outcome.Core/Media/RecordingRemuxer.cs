using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Outcome.Infrastructure.Media;

/// <summary>
/// Rewrites a call recording as the browser's MediaRecorder made it into a file every player can
/// measure and seek — the same streams, nothing re-encoded (<c>-c copy</c>).
///
/// MediaRecorder writes as it goes: MP4 comes out FRAGMENTED, a header saying "duration 0" and
/// then one fragment per keyframe interval with no index anywhere; WebM has no duration and no
/// cues. Chrome shrugs and works it out; Firefox and the iPhone take the header at its word and
/// guess from what has loaded, so the slider reached the end while the call recording went on
/// playing (the owner, 2026-10-05). A remux puts the full sample table and the real duration in
/// front of the data (<c>+faststart</c>), which also makes seeking a long recording instant.
/// </summary>
public sealed class RecordingRemuxer(ILogger<RecordingRemuxer> log)
{
    /// <summary>The remuxed copy of <paramref name="input"/> in a new temporary file, or null when
    /// ffmpeg is missing or refuses the file — the caller then keeps the original, because a
    /// recording that plays awkwardly is far better than one that was lost.</summary>
    public async Task<string?> RemuxAsync(string input, string mime, CancellationToken ct)
    {
        var webm = mime.EndsWith("/webm", StringComparison.Ordinal);
        var output = Path.Combine(Path.GetTempPath(), $"rec_{Guid.NewGuid():N}");
        var args = webm
            ? $"-nostdin -v error -nostats -y -i \"{input}\" -map 0 -c copy -f webm \"{output}\""
            : $"-nostdin -v error -nostats -y -i \"{input}\" -map 0 -c copy -movflags +faststart -f mp4 \"{output}\"";
        try
        {
            using var p = Process.Start(new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = args,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (p is null) return Fail(output, "ffmpeg did not start");
            // Read what it says while it runs: an unread pipe fills and ffmpeg blocks on it forever.
            var stderr = p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);
            var said = await stderr;
            if (p.ExitCode != 0) return Fail(output, $"ffmpeg exit {p.ExitCode}: {said.Trim()}");
            var info = new FileInfo(output);
            if (!info.Exists || info.Length == 0) return Fail(output, "ffmpeg wrote nothing");
            return output;
        }
        catch (OperationCanceledException)
        {
            TryDelete(output);
            throw;
        }
        catch (Exception e)
        {
            return Fail(output, e.Message);
        }
    }

    private string? Fail(string output, string why)
    {
        log.LogWarning("Recording kept as recorded, remux failed: {Why}", why);
        TryDelete(output);
        return null;
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }
}
