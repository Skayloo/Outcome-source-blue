/** Small presentational helpers shared across React components. */

const ROLE_COLORS: Record<string, string> = {
  owner: "var(--role-owner, #e74c3c)",
  admin: "var(--role-admin, #f39c12)",
  moderator: "var(--role-mod, #2ecc71)",
  member: "var(--role-member, #949ba4)",
};

export function roleColor(role: string | null | undefined): string {
  return ROLE_COLORS[(role ?? "member").toLowerCase()] ?? ROLE_COLORS.member!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Palette for initials discs. Picked to stay legible as white-on-colour and to look like
 *  people rather than status: no reds or greens, which in a call already mean muted and
 *  speaking. */
const AVATAR_COLORS = [
  "#5865f2", "#9b59b6", "#e67e22", "#0ea5e9", "#d946a0",
  "#14b8a6", "#7c5cff", "#c2853a", "#3b82f6", "#a855f7",
];

/** A stable colour for a name. Stable is the whole point: the same person must be the same
 *  colour on every screen in the call and after every reconnect, or the disc stops being a way
 *  to recognise anybody. */
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatDayDivider(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

export function sameDay(a: string, b: string): boolean {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** Resolve a possibly-relative attachment/file URL against the current origin. */
export function resolveUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return url; // same-origin relative; the browser resolves it
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
