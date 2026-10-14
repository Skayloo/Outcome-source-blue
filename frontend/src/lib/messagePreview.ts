import type { Message } from "@stores/messages.store";

/**
 * One line describing a message, for the places that quote one instead of showing it:
 * the reply bar over the composer and the reply block above a message.
 *
 * A message with only a picture on it has empty content, and quoting that as an empty
 * string leaves a reply pointing at nothing. Name the attachment instead — which is what
 * every messenger does, and what makes the quote still mean something.
 */
export function messagePreview(m: Pick<Message, "content" | "attachments">): string {
  const text = (m.content ?? "").trim();
  if (text.length > 0) return text;

  const first = m.attachments?.[0];
  if (first == null) return "";
  const mime = first.mime ?? "";
  if (mime.startsWith("image/")) return "Фотография";
  if (mime.startsWith("video/")) return "Видео";
  if (mime.startsWith("audio/")) return "Голосовое сообщение";
  return first.filename || "Файл";
}

/** The kind of a conversation's last file, for the line under its name in the DM list. */
export interface DmFile {
  readonly mime: string;
  readonly durationMs?: number;
}

/** "Фотография", "Голосовое сообщение", … — what the DM list says when the last message is a
 *  file without words. Without it the row was a name over nothing and read as empty. */
export function fileLabel(f: DmFile): string {
  if (f.mime.startsWith("audio/") && f.durationMs != null) return "Голосовое сообщение";
  if (f.mime.startsWith("image/")) return "Фотография";
  if (f.mime.startsWith("video/")) return "Видео";
  if (f.mime.startsWith("audio/")) return "Аудио";
  return "Файл";
}

export function dmFileOf(mime: string | null | undefined, durationMs: number | null | undefined): DmFile | null {
  return mime ? { mime, durationMs: durationMs ?? undefined } : null;
}

/** A live message's first file. */
export function firstFileOf(m: { attachments: readonly { mime: string; duration_ms?: number }[] }): DmFile | null {
  const a = m.attachments[0];
  return a ? { mime: a.mime, durationMs: a.duration_ms } : null;
}
