/**
 * Reactions and raised hands, the parts both voice surfaces share.
 *
 * The signed-in stage and the guest page have different tiles and different rooms, but the
 * controls and the floating emoji must look and behave identically — the same meeting is being
 * held by both, and a guest whose applause looks different from everyone else's has been told
 * they are a second-class participant.
 */
import { useEffect, useRef, useState } from "react";
import { REACTIONS, type Reaction } from "@lib/voiceReactions";
import { VoiceCtl } from "@components/VoiceCtl";
import { t } from "@lib/i18n";

/** How long one reaction stays on screen. Long enough to read across a grid of tiles, short
 *  enough that a burst does not turn into a wall. */
const LIFETIME_MS = 3200;

export interface FloatingReaction { id: number; emoji: Reaction }

/**
 * Collects reactions per participant and drops them again on their own.
 *
 * `subscribe` is whatever the surface has — the session helper in the app, the room helper on
 * the guest page — and is re-subscribed whenever `deps` change.
 */
export function useReactionFeed<K extends string | number>(
  subscribe: (cb: (key: K, emoji: Reaction) => void) => () => void,
  deps: readonly unknown[],
): ReadonlyMap<K, readonly FloatingReaction[]> {
  const [feed, setFeed] = useState<ReadonlyMap<K, readonly FloatingReaction[]>>(new Map());
  const seq = useRef(0);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const off = subscribe((key, emoji) => {
      const id = ++seq.current;
      setFeed((prev) => new Map(prev).set(key, [...(prev.get(key) ?? []), { id, emoji }]));
      timers.push(setTimeout(() => {
        setFeed((prev) => {
          const left = (prev.get(key) ?? []).filter((r) => r.id !== id);
          const next = new Map(prev);
          if (left.length === 0) next.delete(key); else next.set(key, left);
          return next;
        });
      }, LIFETIME_MS));
    });
    return () => {
      off();
      for (const timer of timers) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the surface decides when to resubscribe
  }, deps);

  return feed;
}

/** The emoji themselves, floating up out of a tile. Purely decorative — pointer-events off, so
 *  it can never swallow the right-click that opens the participant menu underneath. */
export function FloatingReactions({ items }: { items: readonly FloatingReaction[] }) {
  if (items.length === 0) return null;
  return (
    <div className="vfx-float" aria-hidden="true">
      {items.map((r) => <span key={r.id} className="vfx-float-item">{r.emoji}</span>)}
    </div>
  );
}

/** Hand toggle plus the reaction picker, for a voice control bar. */
export function VoiceFxControls(
  { handUp, onHand, onReact }:
  { handUp: boolean; onHand: (up: boolean) => void; onReact: (emoji: Reaction) => void },
) {
  const [open, setOpen] = useState(false);

  // Close on the next click anywhere, and on Escape: a picker that stays open behind the
  // conversation is a picker somebody sends a party popper from by accident.
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <VoiceCtl
        glyph="✋"
        label={handUp ? t("voice.handDown") : t("voice.handUp")}
        on={handUp}
        onClick={() => onHand(!handUp)}
      />
      <div className="vfx-picker-wrap" onPointerDown={(e) => e.stopPropagation()}>
        <VoiceCtl glyph="🙂" label={t("voice.react")} on={open} onClick={() => setOpen((v) => !v)} />
        {open && (
          <div className="vfx-picker" role="menu">
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                className="vfx-pick"
                role="menuitem"
                title={emoji}
                onClick={() => { onReact(emoji); setOpen(false); }}
              >{emoji}</button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
