/**
 * Long lines and text files.
 *
 * A line longer than the server takes (CreateMessageHandler.MaxMessageLength, 4000 characters) goes
 * as a text file named message.txt, as Discord does — the owner, 2026-11-09: people pasted logs and
 * stack traces and got "message content exceeds maximum length". The chat then shows such a file
 * read in place (TextFileCard), so it still reads like a message: a few lines, "expand", full screen.
 */

/** What the server takes in one line. Longer goes as a file. */
export const MAX_MESSAGE_CHARS = 4000;
export const LONG_MESSAGE_NAME = "message.txt";

export function longMessageFile(text: string): File {
  return new File([text], LONG_MESSAGE_NAME, { type: "text/plain" });
}

/** Text files bigger than this are a plain download: reading one in place means fetching it whole. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
const TEXT_NAME = /\.(txt|log|md|csv)$/i;

/** A file the chat reads in place — by its name, or its type where the server kept the sender's. */
export function isTextFile(name: string, mime: string, size: number): boolean {
  if (size <= 0 || size > TEXT_PREVIEW_MAX_BYTES) return false;
  return TEXT_NAME.test(name) || mime.split(";")[0]!.trim().toLowerCase() === "text/plain";
}

/**
 * Bytes this page already holds, by attachment id — files it opened or uploaded itself. Their url
 * is a blob: one, which the page may not fetch() (connect-src has no blob:), so the text is read
 * from the Blob instead. Emptied at sign-out.
 */
const held = new Map<string, Blob>();

export function holdFileBytes(id: string, blob: Blob): void {
  held.set(id, blob);
}

/** The bytes of a file this page holds (a sealed photo it opened, say) — saved without fetching it. */
export function heldFileBytes(id: string): Blob | undefined {
  return held.get(id);
}

export function forgetHeldFileBytes(): void {
  held.clear();
}

/** The text of an attachment: from the bytes held here, else downloaded. Null when neither works. */
export async function readTextFile(id: string, url: string): Promise<string | null> {
  const blob = held.get(id);
  if (blob) return blob.text();
  if (/^blob:/i.test(url)) return null;
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
