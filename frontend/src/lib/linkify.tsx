import type { ReactNode } from "react";

// Match http/https URLs, trimming common trailing punctuation.
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,!?:;)"'\]])/gi;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?[^\s]*)?$/i;

export function isImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url);
}

const MENTION_RE = /@([\w.\-]{2,32})/g;

export interface LinkifyOptions {
  /** Style @name only when this returns true (usually: it's a server member). */
  readonly isMention?: (name: string) => boolean;
  /** Lowercased own username — its mentions get the louder "self" style. */
  readonly selfName?: string | null;
}

/** Turn plain text segments into text + highlighted @mention spans. */
function mentionify(text: string, keyBase: string, opts: LinkifyOptions): ReactNode[] {
  if (!opts.isMention) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const name = m[1]!;
    if (!opts.isMention(name)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    const self = opts.selfName != null && name.toLowerCase() === opts.selfName;
    out.push(<span key={`${keyBase}m${i++}`} className={"mention" + (self ? " self" : "")}>@{name}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render message text with clickable links and highlighted @mentions. */
export function linkify(text: string, opts: LinkifyOptions = {}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(...mentionify(text.slice(last, m.index), `s${i}`, opts));
    const url = m[0];
    nodes.push(
      <a key={`l${i++}`} className="msg-link" href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    last = m.index + url.length;
  }
  if (last < text.length) nodes.push(...mentionify(text.slice(last), `t`, opts));
  return nodes;
}

/** Distinct image URLs found in the text (for inline previews). */
export function imageUrlsIn(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (isImageUrl(m[0]) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}
