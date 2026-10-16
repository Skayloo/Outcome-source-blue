// HEIC/HEIF — an iPhone's photos — outside Safari.
//
// Chromium, and with it the desktop app, cannot decode HEIC at all. The server turns an uploaded
// photo into JPEG (1.31.67), but three kinds of HEIC never pass through that: a DM's sealed files
// (the server holds only ciphertext), photos stored before 1.31.67, and a desktop user picking a
// .heic to send into a sealed DM. Those are decoded here, with libheif compiled to wasm.
//
// The decoder is ~3 MB, so it is a separate chunk fetched the first time a HEIC actually has to
// be drawn — nobody who never sees one downloads it. `heic-to/csp` rather than the default build:
// the default one calls `new Function`, which the site's CSP refuses.

/** HEVC-in-HEIF brands of the ISO-BMFF `ftyp` box — what the server sniffs (`MimeSniffer`). */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
/** Generic HEIF brands. AVIF carries them too, so alone they prove nothing — and Chromium draws
 *  AVIF, so taking one for HEIC would also poison the cached "draws HEIC" answer below. */
const GENERIC_BRANDS = new Set(["mif1", "msf1"]);

/** Whether a file's declared type or name says HEIC/HEIF. Windows often gives a .heic no type. */
export function looksHeif(mime: string, name?: string): boolean {
  return /^image\/hei[cf]/i.test(mime) || (name !== undefined && /\.hei[cf]$/i.test(name));
}

/** Whether these bytes are a HEIF image, by the `ftyp` box rather than by what anyone claimed. */
export async function isHeif(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (head.length < 12) return false;
  const ascii = (from: number) => String.fromCharCode(head[from]!, head[from + 1]!, head[from + 2]!, head[from + 3]!);
  if (ascii(4) !== "ftyp") return false;
  const major = ascii(8);
  if (HEIF_BRANDS.has(major)) return true;
  if (!GENERIC_BRANDS.has(major)) return false;
  // A generic major brand: HEIC only if an HEVC brand is among the compatible ones.
  const boxSize = (head[0]! << 24 | head[1]! << 16 | head[2]! << 8 | head[3]!) >>> 0;
  for (let i = 16; i + 4 <= Math.min(head.length, boxSize); i += 4) if (HEIF_BRANDS.has(ascii(i))) return true;
  return false;
}

let drawsHeif: Promise<boolean> | null = null;

/** Whether this browser draws HEIC itself (Safari does). Asked once, on the first real file. */
async function browserDrawsHeif(sample: Blob): Promise<boolean> {
  drawsHeif ??= createImageBitmap(sample).then((b) => { b.close(); return true; }, () => false);
  return drawsHeif;
}

/** A HEIC/HEIF as a JPEG this browser can draw — or the blob itself where it can already. */
export async function heifToJpeg(blob: Blob, quality = 0.9): Promise<Blob> {
  if (await browserDrawsHeif(blob)) return blob;
  const { heicTo } = await import("heic-to/csp");
  return heicTo({ blob, type: "image/jpeg", quality });
}

/** The name a converted file is shown under: the same, ending in .jpg. */
export function jpegName(name: string): string {
  return /\.hei[cf]$/i.test(name) ? name.replace(/\.hei[cf]$/i, ".jpg") : name;
}
