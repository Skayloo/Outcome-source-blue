/**
 * Reactions and raised hands, the parts both voice surfaces share.
 *
 * The signed-in stage and the guest page have different tiles and different rooms, but the
 * controls and the floating emoji must look and behave identically — the same meeting is being
 * held by both, and a guest whose applause looks different from everyone else's has been told
 * they are a second-class participant.
 */
import { useEffect, useRef, useState } from "react";
import { REACTIONS, type Reaction, type Fx } from "@lib/voiceReactions";
import { VoiceCtl } from "@components/VoiceCtl";
import { t } from "@lib/i18n";
import { assetUrl } from "@lib/serverHost";
import { useStoreState } from "@lib/useStore";
import { gifsStore, loadGifs, addGif, removeGif, GIF_ACCEPT, GIF_MAX_COUNT } from "@lib/gifs";
import { Icon } from "@lib/icons";

/** How long one reaction stays on screen. Long enough to read across a grid of tiles, short
 *  enough that a burst does not turn into a wall. A GIF gets longer: it has to load first, and a
 *  loop cut off half-way reads as broken. */
const LIFETIME_MS = 3200;
const GIF_LIFETIME_MS = 5000;

export interface FloatingReaction { id: number; fx: Fx }

/**
 * Collects reactions per participant and drops them again on their own.
 *
 * `subscribe` is whatever the surface has — the session helper in the app, the room helper on
 * the guest page — and is re-subscribed whenever `deps` change.
 */
export function useReactionFeed<K extends string | number>(
  subscribe: (cb: (key: K, fx: Fx) => void) => () => void,
  deps: readonly unknown[],
): ReadonlyMap<K, readonly FloatingReaction[]> {
  const [feed, setFeed] = useState<ReadonlyMap<K, readonly FloatingReaction[]>>(new Map());
  const seq = useRef(0);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const off = subscribe((key, fx) => {
      const id = ++seq.current;
      setFeed((prev) => new Map(prev).set(key, [...(prev.get(key) ?? []), { id, fx }]));
      timers.push(setTimeout(() => {
        setFeed((prev) => {
          const left = (prev.get(key) ?? []).filter((r) => r.id !== id);
          const next = new Map(prev);
          if (left.length === 0) next.delete(key); else next.set(key, left);
          return next;
        });
      }, typeof fx === "string" ? LIFETIME_MS : GIF_LIFETIME_MS));
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
      {items.map((r) => typeof r.fx === "string"
        ? <span key={r.id} className="vfx-float-item">{r.fx}</span>
        : <img key={r.id} className="vfx-float-item vfx-float-gif" src={assetUrl(r.fx.gif)} alt="" draggable={false} />)}
    </div>
  );
}

/** Hand toggle plus the reaction picker, for a voice control bar. `onGif` adds the user's own
 *  GIF library as a second tab — the signed-in stage has one, a guest does not. */
export function VoiceFxControls(
  { handUp, onHand, onReact, onGif }:
  { handUp: boolean; onHand: (up: boolean) => void; onReact: (emoji: Reaction) => void; onGif?: (path: string) => void },
) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"emoji" | "gif">("emoji");

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
          <div className={"vfx-picker" + (onGif !== undefined ? " with-tabs" : "")} role="menu">
            {onGif !== undefined && (
              <div className="vfx-tabs">
                <button className={tab === "emoji" ? "on" : ""} onClick={() => setTab("emoji")}>{t("voice.fxEmoji")}</button>
                <button className={tab === "gif" ? "on" : ""} onClick={() => setTab("gif")}>GIF</button>
              </div>
            )}
            {tab === "gif" && onGif !== undefined
              ? <GifTab onPick={(path) => { onGif(path); setOpen(false); }} />
              : <div className="vfx-emoji-grid">
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      className="vfx-pick"
                      role="menuitem"
                      title={emoji}
                      onClick={() => { onReact(emoji); setOpen(false); }}
                    >{emoji}</button>
                  ))}
                </div>}
          </div>
        )}
      </div>
    </>
  );
}

/** The user's own GIFs: send one, add one, take one away. */
function GifTab({ onPick }: { onPick: (path: string) => void }) {
  const { items, busy } = useStoreState(gifsStore);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void loadGifs(); }, []);

  const upload = (file: File | undefined): void => {
    if (file === undefined) return;
    setError(null);
    void addGif(file).then((err) => {
      if (err === null) return;
      setError(err === "type" ? t("voice.gifType") : err === "size" ? t("voice.gifSize")
        : err === "count" ? t("voice.gifCount", { n: GIF_MAX_COUNT }) : err);
    });
  };

  return (
    <div className="vfx-gif-tab">
      <div className="vfx-gif-grid">
        <label className={"vfx-gif-add" + (busy ? " busy" : "")} title={t("voice.gifAdd")}>
          <Icon name={busy ? "loader" : "plus"} size={20} />
          <input type="file" accept={GIF_ACCEPT} hidden disabled={busy}
            onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {(items ?? []).map((g) => (
          <div key={g.id} className="vfx-gif">
            <button className="vfx-gif-send" onClick={() => onPick(g.url)} title={t("voice.gifSend")}>
              <img src={assetUrl(g.url)} alt="" loading="lazy" draggable={false} />
            </button>
            <button className="vfx-gif-del" title={t("voice.gifDelete")} aria-label={t("voice.gifDelete")}
              onClick={() => void removeGif(g.id)}><Icon name="x" size={12} /></button>
          </div>
        ))}
      </div>
      {items !== null && items.length === 0 && !busy && <div className="vfx-gif-hint">{t("voice.gifEmpty")}</div>}
      {error && <div className="vfx-gif-error">{error}</div>}
    </div>
  );
}
