import type { ChatMessagePayload } from "./types";
import { loadPref } from "@components/settings/helpers";
import { t } from "@lib/i18n";

/**
 * Desktop notifications, notification sounds, and a taskbar/title flash for
 * incoming messages while the window is unfocused. The dispatcher calls
 * notifyIncomingMessage() on every incoming chat message.
 *
 * Web equivalents of the deprecated Tauri-native behaviour:
 *  - desktop notification  -> Web Notification API
 *  - notification sound     -> Web Audio oscillator chime
 *  - flash taskbar          -> animate document.title (browsers can't flash the OS taskbar)
 */

let audioCtx: AudioContext | null = null;
let titleFlashTimer: ReturnType<typeof setInterval> | null = null;
let originalTitle = "";

/** Ask for desktop-notification permission (call from a user gesture, e.g. a button). */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); }
  catch { return Notification.permission; }
}

let permissionPromptArmed = false;
/**
 * Ask for notification permission on the user's first interaction after login.
 * Requesting on the first gesture (not on page load) satisfies browsers — Firefox
 * and Safari require a user gesture — while still being automatic, so message and
 * call notifications work out of the box without a trip to Settings.
 */
export function armNotificationPermissionPrompt(): void {
  if (permissionPromptArmed) return;
  permissionPromptArmed = true;
  if (!("Notification" in window) || Notification.permission !== "default") return;
  const ask = (): void => {
    document.removeEventListener("pointerdown", ask);
    document.removeEventListener("keydown", ask);
    void requestNotificationPermission();
  };
  document.addEventListener("pointerdown", ask);
  document.addEventListener("keydown", ask);
}

function playChime(): void {
  try {
    audioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.18);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.start(t); osc.stop(t + 0.21);
  } catch { /* audio may be blocked until a gesture */ }
}

function startTitleFlash(text: string): void {
  if (titleFlashTimer !== null) return;
  originalTitle = document.title;
  let on = false;
  titleFlashTimer = setInterval(() => {
    on = !on;
    document.title = on ? `🔔 ${text}` : originalTitle;
  }, 1000);
  window.addEventListener("focus", stopTitleFlash, { once: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) stopTitleFlash(); }, { once: true });
}

export function stopTitleFlash(): void {
  if (titleFlashTimer === null) return;
  clearInterval(titleFlashTimer);
  titleFlashTimer = null;
  if (originalTitle) document.title = originalTitle;
}

function mentionsEveryone(content: string): boolean {
  return /@everyone\b|@here\b/.test(content);
}

export function notifyIncomingMessage(payload: ChatMessagePayload, mentioned = false): void {
  // Only notify when the user isn't actively looking at the app.
  if (document.hasFocus()) return;

  const suppressEveryone = loadPref("suppressEveryone", false);
  if (suppressEveryone && mentionsEveryone(payload.content)) return;

  const username = (payload as { user?: { username?: string } }).user?.username ?? "New message";
  const title = mentioned ? t("notif.mentioned", { name: username }) : username;
  const preview = (payload.content ?? "").slice(0, 100);

  if (loadPref("desktopNotifications", true) && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body: preview, tag: "outcome-msg" });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  }

  if (loadPref("notificationSounds", true)) playChime();

  if (loadPref("flashTaskbar", true)) startTitleFlash(`${title}: ${preview}`.slice(0, 60));
}

/**
 * Incoming 1-on-1 call: fire an OS-level desktop notification + title flash when the
 * window isn't focused (the in-app IncomingCallModal + ringtone cover the focused case).
 * requireInteraction keeps the popup up until the user acts, since a call is time-sensitive.
 */
let callNotification: Notification | null = null;

export function notifyIncomingCall(callerName: string, avatar?: string | null): void {
  if (document.hasFocus()) return;

  const title = `📞 ${callerName}`;
  const body = t("call.incomingNotification");

  if (loadPref("desktopNotifications", true) && "Notification" in window && Notification.permission === "granted") {
    try {
      closeCallNotification();
      const n = new Notification(title, {
        body,
        tag: "outcome-call",
        requireInteraction: true,
        icon: avatar ?? undefined,
      });
      n.onclick = () => { window.focus(); n.close(); };
      callNotification = n;
    } catch { /* ignore */ }
  }

  if (loadPref("flashTaskbar", true)) startTitleFlash(title);
}

/** Dismiss the sticky incoming-call popup — the call was answered, declined, or cancelled.
 *  requireInteraction notifications never auto-dismiss, so this must be explicit. */
export function closeCallNotification(): void {
  if (callNotification !== null) {
    try { callNotification.close(); } catch { /* ignore */ }
    callNotification = null;
  }
}
