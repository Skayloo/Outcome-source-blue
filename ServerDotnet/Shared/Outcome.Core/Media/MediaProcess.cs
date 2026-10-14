using System.Diagnostics;

namespace Outcome.Infrastructure.Media;

/// <summary>
/// The one way ffmpeg and ffprobe are run on what users upload. Before, each caller started the
/// process on its own: no time limit, stderr redirected but never read (ffmpeg's progress filled
/// the pipe and the process blocked on it, forever), nothing killed on cancel, any number at once,
/// and ffmpeg free to follow whatever an "upload" pointed at — a playlist naming http:// or
/// file:// sources is a valid input, so a voice message could make the server fetch URLs or read
/// its own files.
/// </summary>
public static class MediaProcess
{
    /// <summary>Input options for every decode of an upload: local files only, and only the
    /// demuxers the caller expects (no playlists, no concat lists).</summary>
    public static string InputGuard(string formats) => $"-protocol_whitelist file -format_whitelist {formats}";

    /// <summary>What a voice clip or a call recording may be: MP4/M4A/MOV, WebM/Matroska, Ogg,
    /// WAV, MP3, AAC.</summary>
    public const string AudioVideoFormats = "mov,matroska,ogg,wav,mp3,aac";

    /// <summary>What a picture may be. mov covers HEIC/AVIF; image2 the plain image demuxer.</summary>
    public const string ImageFormats = "png_pipe,jpeg_pipe,gif,webp_pipe,bmp_pipe,tiff_pipe,mov,image2";

    // A few at a time per replica: each one is a CPU-bound process holding a temp copy of the
    // upload, and nothing else bounded how many a burst of uploads could start.
    private static readonly SemaphoreSlim Slots = new(Math.Max(2, Environment.ProcessorCount / 2));

    public sealed record Result(int ExitCode, byte[] Stdout, string Stderr);

    /// <summary>Runs <paramref name="exe"/>; null when it is missing, timed out or was cancelled
    /// (the process tree is killed either way). Stdout is kept when asked for, stderr always read
    /// — to its last 4 KB — so neither pipe can fill and stall the process.</summary>
    public static async Task<Result?> RunAsync(string exe, string args, TimeSpan timeout, bool captureStdout, CancellationToken ct)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(timeout);
        try { await Slots.WaitAsync(limit.Token); }
        catch (OperationCanceledException) { return null; }
        try
        {
            Process? p;
            try
            {
                p = Process.Start(new ProcessStartInfo
                {
                    FileName = exe,
                    Arguments = args,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
            }
            catch { return null; } // not installed → the caller carries on without
            if (p is null) return null;
            using (p)
            {
                var stdout = captureStdout ? ReadAllAsync(p.StandardOutput.BaseStream) : DrainAsync(p.StandardOutput.BaseStream);
                var stderr = TailAsync(p.StandardError.BaseStream);
                try { await p.WaitForExitAsync(limit.Token); }
                catch (OperationCanceledException)
                {
                    try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
                    return null;
                }
                return new Result(p.ExitCode, await stdout, await stderr);
            }
        }
        finally { Slots.Release(); }
    }

    private static async Task<byte[]> ReadAllAsync(Stream s)
    {
        using var ms = new MemoryStream();
        try { await s.CopyToAsync(ms); } catch { /* process killed */ }
        return ms.ToArray();
    }

    private static async Task<byte[]> DrainAsync(Stream s)
    {
        var buf = new byte[8192];
        try { while (await s.ReadAsync(buf) > 0) { } } catch { /* process killed */ }
        return [];
    }

    private static async Task<string> TailAsync(Stream s)
    {
        const int keep = 4096;
        var buf = new byte[8192];
        var tail = new List<byte>(keep * 2);
        try
        {
            int n;
            while ((n = await s.ReadAsync(buf)) > 0)
            {
                tail.AddRange(buf.AsSpan(0, n));
                if (tail.Count > keep * 2) tail.RemoveRange(0, tail.Count - keep);
            }
        }
        catch { /* process killed */ }
        if (tail.Count > keep) tail.RemoveRange(0, tail.Count - keep);
        return System.Text.Encoding.UTF8.GetString(tail.ToArray());
    }
}
