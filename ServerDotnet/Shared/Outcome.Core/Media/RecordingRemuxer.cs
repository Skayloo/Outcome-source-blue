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

    /// <summary>Is this the MP4 MediaRecorder wrote — a <c>moof</c> straight after the
    /// <c>moov</c> — rather than one already remuxed (<c>moov</c>, then <c>free</c>/<c>mdat</c>)?
    /// Reads only the top-level box headers up to there; a remuxed file answers false, which is
    /// what keeps the backfill from touching a file twice.</summary>
    public static async Task<bool> IsFragmentedMp4Async(Stream s, CancellationToken ct = default)
    {
        var head = new byte[16];
        var skip = new byte[1 << 16];
        for (var boxes = 0; boxes < 8; boxes++)
        {
            if (!await ReadExactlyAsync(s, head, 8, ct)) return false;
            long size = (uint)((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]);
            var type = System.Text.Encoding.ASCII.GetString(head, 4, 4);
            var header = 8;
            if (size == 1)
            {
                if (!await ReadExactlyAsync(s, head, 8, ct)) return false;
                size = (long)System.Buffers.Binary.BinaryPrimitives.ReadUInt64BigEndian(head.AsSpan(0, 8));
                header = 16;
            }
            if (type == "moof") return true;
            if (type is "mdat" or "free" || size < header || size > 64L * 1024 * 1024) return false;
            for (var left = size - header; left > 0;)
            {
                var n = await s.ReadAsync(skip.AsMemory(0, (int)Math.Min(skip.Length, left)), ct);
                if (n <= 0) return false;
                left -= n;
            }
        }
        return false;
    }

    private static async Task<bool> ReadExactlyAsync(Stream s, byte[] buf, int count, CancellationToken ct)
    {
        for (var got = 0; got < count;)
        {
            var n = await s.ReadAsync(buf.AsMemory(got, count - got), ct);
            if (n <= 0) return false;
            got += n;
        }
        return true;
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
