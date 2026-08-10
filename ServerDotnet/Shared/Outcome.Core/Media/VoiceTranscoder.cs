using System.Diagnostics;
using Newtonsoft.Json;

namespace Outcome.Infrastructure.Media;

/// <summary>Normalizes a recorded voice clip (webm/ogg/mp4 — whatever the browser produced) to
/// m4a/AAC so every platform can play it, and extracts a compact amplitude waveform for the UI.
/// Shells out to ffmpeg (added to the runtime image); no managed audio deps.</summary>
public sealed class VoiceTranscoder
{
    public sealed record Result(byte[] M4a, int DurationMs, string WaveformJson);

    private const int WaveformBars = 48;   // how many peaks the clients draw
    private const int PcmSampleRate = 8000; // low rate is plenty to compute envelope peaks

    /// <summary>Transcode + analyze. Returns null if ffmpeg is missing or the input isn't decodable
    /// (caller then falls back to storing the raw upload as a normal attachment).</summary>
    public async Task<Result?> TranscodeAsync(byte[] input, CancellationToken ct)
    {
        var tmpIn = Path.Combine(Path.GetTempPath(), $"voin_{Guid.NewGuid():N}");
        var tmpOut = Path.Combine(Path.GetTempPath(), $"voout_{Guid.NewGuid():N}.m4a");
        try
        {
            await File.WriteAllBytesAsync(tmpIn, input, ct);

            // 1) Transcode to mono AAC in an m4a container. -vn drops any cover art; 48 kbps mono
            //    is transparent for speech and keeps clips tiny.
            if (!await RunAsync("ffmpeg", $"-nostdin -y -i \"{tmpIn}\" -vn -ac 1 -c:a aac -b:a 48k -movflags +faststart \"{tmpOut}\"", ct))
                return null;
            if (!File.Exists(tmpOut)) return null;
            var m4a = await File.ReadAllBytesAsync(tmpOut, ct);
            if (m4a.Length == 0) return null;

            // 2) Decode to raw mono PCM (s16le) on stdout and fold it into WaveformBars peaks.
            var (pcm, ok) = await RunCaptureAsync("ffmpeg",
                $"-nostdin -i \"{tmpIn}\" -vn -ac 1 -ar {PcmSampleRate} -f s16le -", ct);
            if (!ok || pcm.Length < 2) return new Result(m4a, 0, "[]");

            var totalSamples = pcm.Length / 2;
            var durationMs = (int)(totalSamples * 1000L / PcmSampleRate);
            var peaks = ComputePeaks(pcm, totalSamples);
            return new Result(m4a, durationMs, JsonConvert.SerializeObject(peaks));
        }
        catch
        {
            return null;
        }
        finally
        {
            TryDelete(tmpIn);
            TryDelete(tmpOut);
        }
    }

    /// <summary>Fold s16le PCM into WaveformBars buckets of 0..100 peak amplitude.</summary>
    private static int[] ComputePeaks(byte[] pcm, int totalSamples)
    {
        var bars = new int[WaveformBars];
        if (totalSamples == 0) return bars;
        var per = Math.Max(1, totalSamples / WaveformBars);
        var rawMax = 1;
        var raw = new int[WaveformBars];
        for (var bar = 0; bar < WaveformBars; bar++)
        {
            var start = bar * per;
            var peak = 0;
            for (var i = start; i < start + per && i < totalSamples; i++)
            {
                var s = (short)(pcm[i * 2] | (pcm[i * 2 + 1] << 8));
                var mag = Math.Abs((int)s);
                if (mag > peak) peak = mag;
            }
            raw[bar] = peak;
            if (peak > rawMax) rawMax = peak;
        }
        // Normalize to the clip's own loudest peak so quiet recordings still show a full-height wave.
        for (var b = 0; b < WaveformBars; b++)
            bars[b] = (int)(raw[b] * 100L / rawMax);
        return bars;
    }

    private static async Task<bool> RunAsync(string exe, string args, CancellationToken ct)
    {
        using var p = Start(exe, args, captureStdout: false);
        if (p is null) return false;
        await p.WaitForExitAsync(ct);
        return p.ExitCode == 0;
    }

    private static async Task<(byte[] data, bool ok)> RunCaptureAsync(string exe, string args, CancellationToken ct)
    {
        using var p = Start(exe, args, captureStdout: true);
        if (p is null) return (Array.Empty<byte>(), false);
        using var ms = new MemoryStream();
        await p.StandardOutput.BaseStream.CopyToAsync(ms, ct);
        await p.WaitForExitAsync(ct);
        return (ms.ToArray(), p.ExitCode == 0);
    }

    private static Process? Start(string exe, string args, bool captureStdout)
    {
        try
        {
            return Process.Start(new ProcessStartInfo
            {
                FileName = exe,
                Arguments = args,
                RedirectStandardOutput = captureStdout,
                RedirectStandardError = true, // swallow ffmpeg's progress spam
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch
        {
            return null; // ffmpeg not installed → caller falls back
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }
}
