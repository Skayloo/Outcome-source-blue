import { useEffect } from "react";
import { voiceStore } from "@stores/voice.store";
import { toggleMute, toggleDeafen } from "@lib/voice";
import { enableCamera, disableCamera, setMuted } from "@lib/livekitSession";
import { loadPref } from "@components/settings/helpers";

/** Is the user typing in a text field (so we should not steal bare keys for PTT)? */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/**
 * Global keyboard shortcut layer (mounted once in MainPage). Wires:
 *  - Ctrl/Cmd+Shift+M/D/V → toggle mute / deafen / camera (only while connected to voice)
 *  - the configured Push-to-Talk key (held) → temporarily unmute (browser-focus only)
 *
 * NOTE: Ctrl/Cmd+K is owned solely by MainPage → CommandPalette (a single capture-phase
 * handler) so the two don't fight; do not re-add a Ctrl+K binding here.
 */
export function GlobalKeybinds() {
  useEffect(() => {
    const inVoice = () => voiceStore.getState().currentChannelId != null;
    let pttActive = false;

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "m" && inVoice()) { e.preventDefault(); toggleMute(); return; }
        if (k === "d" && inVoice()) { e.preventDefault(); toggleDeafen(); return; }
        if (k === "v" && inVoice()) {
          e.preventDefault();
          if (voiceStore.getState().localCamera) void disableCamera(); else void enableCamera();
          return;
        }
      }

      // Push-to-talk: hold the configured key to open the mic (ignored while typing).
      const ptt = loadPref<string>("pttKey", "");
      if (ptt && e.code === ptt && inVoice() && !pttActive && !isTyping()) {
        pttActive = true;
        setMuted(false);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const ptt = loadPref<string>("pttKey", "");
      if (ptt && e.code === ptt && pttActive) {
        pttActive = false;
        setMuted(true);
      }
    };

    // Capture phase so a shortcut fires before a focused input swallows the key.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, []);

  return null;
}
