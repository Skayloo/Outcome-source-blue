using System.Diagnostics;

namespace Outcome.Infrastructure.Media;

/// <summary>
/// Reads an image's pixel dimensions with ffprobe, which is already in the image for voice
/// transcoding — so this costs no new dependency and no decoder of our own.
///
/// The point is not the numbers, it is the LAYOUT. Without them a client cannot know the shape
/// of a picture until it has decoded it, so a chat opened from cold draws every photo at a
/// guessed size and then reflows once the bytes land. Sending the shape with the message means
/// the space is right on the first frame.
/// </summary>
public static class ImageProbe
{
    /// <summary>Width and height in pixels, or null if ffprobe is missing, times out, or the
    /// bytes are not something it recognises. Every caller must treat null as "unknown" and
    /// carry on: this is a rendering hint, never a reason to refuse an upload.</summary>
    public static async Task<(int Width, int Height)?> MeasureAsync(byte[] bytes, CancellationToken ct = default)
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"probe_{Guid.NewGuid():N}");
        try
        {
            await File.WriteAllBytesAsync(tmp, bytes, ct);
            using var p = Start($"-v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x \"{tmp}\"");
            if (p is null) return null;

            var outp = await p.StandardOutput.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);
            if (p.ExitCode != 0) return null;

            var parts = outp.Trim().Split('x');
            if (parts.Length < 2) return null;
            if (!int.TryParse(parts[0], out var w) || !int.TryParse(parts[1], out var h)) return null;
            return w > 0 && h > 0 ? (w, h) : null;
        }
        catch
        {
            return null;
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* best effort */ }
        }
    }

    /// <summary>
    /// A downscaled copy, longest side <paramref name="maxDim"/>, JPEG. Null if ffmpeg is
    /// missing or refuses the input — the caller then simply has no preview and serves the
    /// original, which is what happened for every picture before this existed.
    ///
    /// This is the difference between a 30px avatar costing 600 KB and costing 12.
    /// </summary>
    /// <summary>
    /// True for the formats that can carry transparency. Their previews must stay PNG: JPEG has
    /// no alpha channel, and everything transparent in the original comes out BLACK — which is
    /// what a logo with a cut-out background turned into the moment it was previewed.
    /// </summary>
    public static bool KeepsAlpha(string mime) =>
        mime.Equals("image/png", StringComparison.OrdinalIgnoreCase)
        || mime.Equals("image/webp", StringComparison.OrdinalIgnoreCase)
        || mime.Equals("image/gif", StringComparison.OrdinalIgnoreCase);

    public static async Task<byte[]?> PreviewAsync(byte[] bytes, string mime, int maxDim = 512, CancellationToken ct = default)
    {
        var src = Path.Combine(Path.GetTempPath(), $"pv_{Guid.NewGuid():N}");
        var dst = src + (KeepsAlpha(mime) ? ".png" : ".jpg");
        try
        {
            await File.WriteAllBytesAsync(src, bytes, ct);
            // decrease=only shrink: a picture already smaller than the box is left alone rather
            // than blown up into a bigger file than the original.
            using var p = Start(
                $"-v error -y -i \"{src}\" -vf \"scale='min({maxDim},iw)':'min({maxDim},ih)':force_original_aspect_ratio=decrease\" -q:v 6 \"{dst}\"",
                exe: "ffmpeg");
            if (p is null) return null;
            await p.WaitForExitAsync(ct);
            if (p.ExitCode != 0 || !File.Exists(dst)) return null;
            var outBytes = await File.ReadAllBytesAsync(dst, ct);
            // A "preview" bigger than the original helps nobody.
            return outBytes.Length > 0 && outBytes.Length < bytes.Length ? outBytes : null;
        }
        catch
        {
            return null;
        }
        finally
        {
            foreach (var f in new[] { src, dst })
                try { if (File.Exists(f)) File.Delete(f); } catch { /* best effort */ }
        }
    }

    private static Process? Start(string args, string exe = "ffprobe")
    {
        try
        {
            return Process.Start(new ProcessStartInfo
            {
                FileName = exe,
                Arguments = args,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch
        {
            return null; // ffmpeg/ffprobe not installed → the caller carries on without
        }
    }
}
