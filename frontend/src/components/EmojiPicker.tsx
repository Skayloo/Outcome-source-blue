/**
 * EmojiPicker — a small popover for inserting an emoji into a message or as a
 * reaction. Renders a backdrop (closes on outside click), a fixed grid of
 * common unicode emoji, and a "Custom" row populated from the server's custom
 * emoji (GET /api/v1/emoji). Picking a unicode emoji calls onPick(char); picking
 * a custom emoji calls onPick(":shortcode:") — the canonical wire form the
 * server resolves for reactions/messages. Closes on Escape.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@lib/services";
import { assetUrl } from "@lib/serverHost";
import { Banner } from "@components/settings/controls";
import type { EmojiResponse } from "@lib/types";

/** ~80 common unicode emoji across faces, gestures, objects, and symbols. */
const COMMON_EMOJI: readonly string[] = [
  // Faces
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
  "🙂", "😉", "😍", "😘", "😋", "😎", "🤩", "🥳", "🤔", "🤨",
  "😐", "😑", "😶", "🙄", "😏", "😴", "😪", "😌", "😔", "🤤",
  "😜", "😝", "🤪", "🤗", "🤭", "🤫", "😬", "😳", "😢", "😭",
  "😤", "😡", "🤬", "😱", "😨", "😰", "😥", "🥺", "😞", "😩",
  // Gestures / people
  "👍", "👎", "👌", "✌️", "🤞", "🤟", "🤘", "👏", "🙌", "🙏",
  "👋", "🤝", "💪", "🫡", "🤙", "👀", "🫶",
  // Objects / nature / food
  "🔥", "✨", "⭐", "🌟", "💯", "🎉", "🎊", "🎁", "💡", "📌",
  "✅", "❌", "⚡", "🚀", "💻", "📎", "🍕", "☕",
  // Symbols / hearts
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "💖", "💢",
];

const PANEL_BG = "var(--bg-tertiary)";

interface EmojiPickerProps {
  readonly onPick: (emoji: string) => void;
  readonly onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: EmojiPickerProps) {
  const [custom, setCustom] = useState<readonly EmojiResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [openDown, setOpenDown] = useState(false);

  // The popover opens UPWARD by default; for a message near the top of the viewport that would
  // clip it behind the header. Measure before paint and flip to open downward when needed.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (el && el.getBoundingClientRect().top < 70) setOpenDown(true);
  }, []);

  // Fetch custom server emoji; abort on unmount.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void api
      .getEmoji(controller.signal)
      .then((list: EmojiResponse[]) => {
        if (active) setCustom(list);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load custom emoji.");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickUnicode = (emoji: string) => onPick(emoji);
  const pickCustom = (e: EmojiResponse) => onPick(`:${e.shortcode}:`);

  return (
    <>
      {/* Backdrop: clicking anywhere outside the panel closes the popover. */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 999 }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Pick an emoji"
        onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}
        style={{
          position: "absolute",
          ...(openDown ? { top: "calc(100% + 8px)" } : { bottom: "calc(100% + 8px)" }),
          right: 0,
          zIndex: 1000,
          width: 320,
          maxHeight: 280,
          overflowY: "auto",
          background: PANEL_BG,
          border: "1px solid var(--bg-active)",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          padding: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            color: "var(--text-muted)",
            margin: "2px 4px 6px",
          }}
        >
          Emoji
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            gap: 2,
          }}
        >
          {COMMON_EMOJI.map((emoji, i) => (
            <button
              // Some emoji (e.g. variation selectors) can collide; index keeps keys unique.
              key={`${emoji}-${i}`}
              type="button"
              title={emoji}
              onClick={() => pickUnicode(emoji)}
              style={{
                background: "transparent",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: 4,
                aspectRatio: "1 / 1",
              }}
              onMouseEnter={(ev: React.MouseEvent<HTMLButtonElement>) => {
                ev.currentTarget.style.background = "var(--bg-active)";
              }}
              onMouseLeave={(ev: React.MouseEvent<HTMLButtonElement>) => {
                ev.currentTarget.style.background = "transparent";
              }}
            >
              {emoji}
            </button>
          ))}
        </div>

        {custom.length > 0 && (
          <>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                color: "var(--text-muted)",
                margin: "10px 4px 6px",
              }}
            >
              Custom
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(8, 1fr)",
                gap: 2,
              }}
            >
              {custom.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  title={`:${e.shortcode}:`}
                  onClick={() => pickCustom(e)}
                  style={{
                    background: "transparent",
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    padding: 4,
                    aspectRatio: "1 / 1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  onMouseEnter={(ev: React.MouseEvent<HTMLButtonElement>) => {
                    ev.currentTarget.style.background = "var(--bg-active)";
                  }}
                  onMouseLeave={(ev: React.MouseEvent<HTMLButtonElement>) => {
                    ev.currentTarget.style.background = "transparent";
                  }}
                >
                  <img
                    src={assetUrl(e.filename.startsWith("/") ? e.filename : `/files/${e.filename}`)}
                    alt={`:${e.shortcode}:`}
                    width={20}
                    height={20}
                    style={{ objectFit: "contain", display: "block" }}
                    onError={(ev: React.SyntheticEvent<HTMLImageElement>) => {
                      // If the image can't load, fall back to a compact text chip
                      // so the emoji is still pickable.
                      const img = ev.currentTarget;
                      img.style.display = "none";
                      const parent = img.parentElement;
                      if (parent && !parent.querySelector("[data-emoji-fallback]")) {
                        const span = document.createElement("span");
                        span.setAttribute("data-emoji-fallback", "");
                        span.textContent = `:${e.shortcode}:`;
                        span.style.fontSize = "9px";
                        span.style.color = "var(--text-muted)";
                        span.style.wordBreak = "break-all";
                        parent.appendChild(span);
                      }
                    }}
                  />
                </button>
              ))}
            </div>
          </>
        )}

        {error && <Banner kind="error">{error}</Banner>}
      </div>
    </>
  );
}
