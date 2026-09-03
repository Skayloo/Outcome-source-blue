'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Which server, and knowing we are a shell ─────────────────────────────────
// Both of these run at document-start, before any of the SPA's own scripts, because both are
// read during its first render.
//
// The host matters more than it looks. In a browser the SPA falls back to the origin that
// served it; here that origin is app://, which serves the bundle and nothing else. Left unset,
// the login POST goes to app://outcome/api/v1/auth/login, the protocol handler answers with
// index.html, and the user is shown «Unexpected token '<'» — a JSON parser complaining about
// a page, with nothing on screen connecting that to "no server chosen". Seeding the key the
// SPA already uses to remember the last server avoids the whole class of it, and "Сменить
// сервер" on the login screen still works exactly as before.
const DEFAULT_HOST = process.env.OUTCOME_DEFAULT_HOST || 'outcome.ru';

try {
  if (!localStorage.getItem('outcome:lastHost')) {
    localStorage.setItem('outcome:lastHost', DEFAULT_HOST);
  }
} catch { /* private mode or a locked-down store: the login screen still lets them type one */ }

// Lets the stylesheet drop things that only make sense on a web page — see login.css.
try {
  document.documentElement.classList.add('outcome-desktop');
} catch { /* documentElement not up yet; the DOMContentLoaded pass below covers it */ }
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('outcome-desktop');
});

/**
 * The only bridge between the shell and the SPA.
 *
 * Deliberately tiny and deliberately not `ipcRenderer` itself: the renderer runs a full
 * messenger, including message text other people wrote. Handing it a general IPC channel
 * would make every XSS in the web client a way to talk to the main process.
 *
 * The SPA feature-detects this object, so the same bundle keeps working in a browser where
 * it is simply absent.
 */
contextBridge.exposeInMainWorld('outcomeDesktop', {
  /** Marks this as the packaged shell — the web build has no such object. */
  version: process.versions.electron,
  platform: process.platform,

  /**
   * Register (or clear, with "") the system-wide push-to-talk key.
   * Electron accelerators, e.g. "F13", "CommandOrControl+Shift+Space".
   * Resolves false when the OS refused it — usually because another app holds it.
   */
  setPushToTalk: (accelerator) => ipcRenderer.invoke('outcome:set-ptt', accelerator || ''),

  /** Unread count for the dock badge (macOS/Linux) or the tray tooltip (Windows). */
  setBadge: (count) => ipcRenderer.invoke('outcome:set-badge', count),

  /**
   * Hand a URL to the user's browser.
   *
   * Used by the SSO flow, which cannot run inside this window: /start sets an anti-CSRF nonce
   * cookie that the callback insists on seeing again, and the provider's consent page is a
   * third party we have no business hosting in a shell that carries a preload bridge.
   */
  openExternal: (url) => ipcRenderer.invoke('outcome:open-external', url),

  /**
   * The SSO callback coming home as `outcome://sso?token=…`.
   *
   * The browser finishes the round-trip and hands the token back to the app through the URL
   * scheme — the same path the phone apps use, and the reason /start is asked for `target=app`
   * here rather than `target=web`. Without this the token lands in the browser's copy of the
   * web client and the desktop window sits there still logged out.
   */
  onSso: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('outcome:sso', listener);
    return () => ipcRenderer.removeListener('outcome:sso', listener);
  },

  /**
   * Fires when the global PTT key is pressed. A TOGGLE, not a hold — see the note in
   * main.js: globalShortcut has no key-up event, so the shell cannot express hold-to-talk
   * without a native keyboard hook.
   */
  onPushToTalk: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('outcome:ptt-toggle', listener);
    return () => ipcRenderer.removeListener('outcome:ptt-toggle', listener);
  },
});
