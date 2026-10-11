/** Dates, quotes and names for the admin mail client — written the way mail clients write them. */
import { getLocale, t } from "@lib/i18n";
import type { MailMessage, MailSummary } from "@lib/types";

const lang = (): string => (getLocale() === "ru" ? "ru-RU" : "en-GB");

/** In a list: the time for today, day and month this year, the full date before that. */
export function listDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1980) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString(lang(), { day: "numeric", month: "short" });
  return d.toLocaleDateString(lang(), { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Above an open message: weekday, date and time. */
export function fullDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang(), {
    weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function senderName(m: Pick<MailSummary, "from" | "from_name">): string {
  return m.from_name.trim() || m.from || t("mail.unknownSender");
}

/** "Name <address>", or just the address. */
export function fullSender(m: Pick<MailMessage, "from" | "from_name">): string {
  return m.from_name.trim() ? `${m.from_name} <${m.from}>` : m.from;
}

/** "Re: …" once, not "Re: Re: Re: …". */
export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return /^\s*fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/** The quoted original under a reply: a header line and every line behind "> ". */
export function quoteFor(m: MailMessage): string {
  const header = t("mail.quoteHeader", { date: fullDate(m.date), sender: fullSender(m) });
  const body = m.text.split("\n").map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`)).join("\n");
  return `\n\n${header}\n${body}`;
}

/** The forwarded original below a forward: the header block Gmail and Yandex write. */
export function forwardBody(m: MailMessage): string {
  const lines = [
    "",
    "",
    t("mail.forwardHeader"),
    `${t("mail.from")}: ${fullSender(m)}`,
    `${t("mail.date")}: ${fullDate(m.date)}`,
    `${t("mail.subject")}: ${m.subject}`,
    `${t("mail.to")}: ${m.to.join(", ")}`,
  ];
  if (m.cc.length > 0) lines.push(`${t("mail.cc")}: ${m.cc.join(", ")}`);
  return `${lines.join("\n")}\n\n${m.text}`;
}

/** Addresses typed into a field: split on commas/semicolons, trimmed, empties dropped. */
export function splitAddresses(raw: string): string[] {
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/** Good enough to stop an obvious typo before the server is asked; the server decides. */
export function looksLikeAddress(s: string): boolean {
  const addr = s.match(/<([^>]+)>\s*$/)?.[1] ?? s;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim());
}
