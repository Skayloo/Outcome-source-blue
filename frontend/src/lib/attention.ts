// Whether the person is AT this tab or desktop window right now, told to the server with an
// `attention` frame. The server pushes someone's phone only when none of their connections is
// attended (PushNotifier) — an open but forgotten tab used to keep every push away from the phone.
//
// Attended = the page is visible, the window has focus, and it was touched (pointer, keys, wheel)
// within the last two minutes. The server keeps the answer per connection, and a reconnect is a
// new connection: every READY says it again (dispatcher).
import { wsSend } from "./services";
import { ClientMessageType as C } from "./protocolTypes";

const IDLE_MS = 2 * 60 * 1000;

let lastTouch = Date.now();
let told: boolean | null = null;
let started = false;

function attended(): boolean {
  return document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastTouch < IDLE_MS;
}

function tell(force = false): void {
  const now = attended();
  if (!force && now === told) return;
  told = now;
  wsSend(C.ATTENTION, { active: now });
}

/** After every READY: the connection is new to the server, whatever this page said before. */
export function tellAttentionAgain(): void {
  start();
  tell(true);
}

function start(): void {
  if (started) return;
  started = true;
  const touched = (): void => {
    lastTouch = Date.now();
    if (told === false) tell();
  };
  for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const) {
    window.addEventListener(ev, touched, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", () => tell());
  window.addEventListener("focus", () => { lastTouch = Date.now(); tell(); });
  window.addEventListener("blur", () => tell());
  // Going idle has no event of its own.
  window.setInterval(() => tell(), 15_000);
}
