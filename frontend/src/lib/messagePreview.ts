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
