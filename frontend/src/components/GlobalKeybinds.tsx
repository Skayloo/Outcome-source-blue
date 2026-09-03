import { useEffect } from "react";
import { voiceStore } from "@stores/voice.store";
import { toggleMute, toggleDeafen } from "@lib/voice";
import { enableCamera, disableCamera, setMuted } from "@lib/livekitSession";
import { loadPref } from "@components/settings/helpers";
import { desktop, codeToAccelerator } from "@lib/desktop";

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

  // ── The same key, but system-wide, when running inside the desktop shell ──────────────
  //
  // The handler above only ever sees keys while this window has focus, which is precisely when
  // you are NOT in the other application you are talking about. The shell registers the key
  // with the OS instead.
  //
  // It arrives as a TOGGLE rather than a hold: the OS shortcut API the shell uses reports key
  // presses and not releases, so "unmute while held" cannot be expressed. Both handlers can be
  // live at once without fighting — the browser one only fires when focused, and then the
  // shell does not receive the key at all.
  useEffect(() => {
    const shell = desktop();
    if (!shell) return;

    const accelerator = codeToAccelerator(loadPref<string>("pttKey", ""));
    void shell.setPushToTalk(accelerator);

    const off = shell.onPushToTalk(() => {
      if (voiceStore.getState().currentChannelId == null) return;
      toggleMute();
    });
    return () => {
      off();
      void shell.setPushToTalk(""); // hand the key back to the OS when this unmounts
    };
  }, []);

  return null;
}
