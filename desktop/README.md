# desktop/

The Windows / Linux / macOS client. An Electron shell around the web client in `../frontend`,
distributed as a download — not through any store.

## Why Electron and not Tauri

Tauri would ship a 5–10 MB binary instead of ~150 MB, and that was the obvious first answer.
It uses the operating system's WebView, and there the argument falls apart: on Linux that is
WebKitGTK, whose WebRTC support depends on how the distribution built it and is frequently
absent. Voice, video and screen share are what this product is for, and the audience most
likely to self-host is the one most likely to be on Linux.

Electron carries its own Chromium, so calls behave identically on all three systems and
`desktopCapturer` gives a real window picker. The size is the price of the feature working.

## Why the shell carries its own copy of the UI

`scripts/sync-web.mjs` builds `../frontend` and copies the result into `web/`, which the
`app://` protocol serves. The shell does not load the interface from whichever server the user
signs in to.

Asking a stranger's instance for the code that will run next to a preload bridge is a different
proposition from opening a web page, and a LAN instance may not even be reachable at launch.
Shipping them together also means the preload API can never be missing from the bundle that
expects it.

Edition is **red** by default, the same choice `mobile/` makes: the client is distributed as a
binary rather than as source, so it carries the encryption like the phone apps do. Build the
cipher-free one with `OUTCOME_EDITION=blue npm run sync`.

## Commands

```bash
npm install
npm start          # build the web client, then run the shell
npm run dist:win   # NSIS installer  → release/
npm run dist:linux # AppImage + .deb → release/
npm run dist:mac   # .dmg            → release/   (only on macOS)
```

## What the shell adds over the browser

- **A system-wide push-to-talk key.** In a tab the PTT key only works while the tab has focus —
  see the note in `GlobalKeybinds.tsx` — which is exactly when you are not in the window you
  are talking about.
- **Tray, close-to-tray, launch at login.** The session stays up after the window is closed, so
  calls and notifications still arrive.
- **Screen sharing with a real chooser** — every screen and every open window, with
  thumbnails, and a choice of whether the system sound goes with the picture. The browser
  offers no way to share sound at all on most platforms.
- **An unread badge** on the dock (macOS, Linux) or the tray tooltip (Windows).

## Known limitation: push-to-talk is a toggle, not a hold

Electron's `globalShortcut` reports key **presses and not releases**. "Open the mic while the
key is held" therefore cannot be expressed with it, and the shell registers a toggle instead.

True hold-to-talk needs a native keyboard hook (`uiohook-napi` or equivalent), which brings a
compiled dependency and per-platform prebuilds. Worth doing — it is how Discord does it — but
it is a deliberate second step, not an oversight. The in-window handler still gives real
hold-to-talk while the window has focus.

## Publishing to the Microsoft Store

Worth knowing before starting: a Store listing is the only route that removes the SmartScreen
warning outright, because Microsoft signs the package itself. No certificate is bought, and an
individual developer account does not need a company. That is the whole appeal — every other
route buys a *reputation* that still has to accrue.

Three things it changes, and none of them are optional:

- **The app must not update itself.** Updates come through the Store, self-updating fails
  certification, and the install location is read-only anyway. `wireAutoUpdate` returns early
  on `process.windowsStore`, which Electron sets only for a real Store install — the identity
  of the install talking rather than a build-time guess.
- **The format is MSIX**, and the app runs in a container: writes to its own directory are
  redirected, and the install location cannot be written at all.
- **The final package cannot be built before the account exists.** `identityName` and
  `publisher` come from Partner Center once the app name is reserved and must match the
  submission character for character. They sit in `build.appx` as loud placeholders, and `appx`
  is deliberately absent from `win.target`: a normal build must not quietly produce a package
  that would be rejected. With the real values in place:

```bash
npx electron-builder --win appx --publish never
```

The direct download stays either way. Self-hosters, Linux users and anyone who will not install
from a store still need `Outcome-Setup-1.0.0.exe`, and that build keeps its own updater.

## Known limitation: shared sound is Windows-only

The chooser offers "передавать звук" only on Windows, and only when a whole screen is picked.
Both halves are platform facts rather than choices: Chromium captures system sound by
**loopback**, which Electron implements on Windows alone, and loopback takes the whole device
output — there is no such thing as the sound of one window. The checkbox says which of the two
reasons applies rather than sitting greyed out, because a disabled control with no explanation
reads as a bug.

One trap worth keeping in mind if this code is touched: the `audio` key must be **absent** from
the answer when no sound is shared. Electron validates the property the moment it exists, so
`audio: undefined` throws inside the callback, and the share then produces nothing at all with
no error the user can see.

## Signing, per platform

Unsigned builds run, but each system says something alarming first.

- **Windows** — without a code-signing certificate SmartScreen warns about an unknown
  publisher. The installer works; the warning costs installs.
- **macOS** — Gatekeeper refuses a downloaded app that is not signed with a **Developer ID**
  and **notarized**. This is not the App Store, but it is not optional either. Entitlements for
  microphone, camera and JIT are in `build/entitlements.mac.plist`; without the first two the
  hardened runtime silently denies the microphone.
- **Linux** — nothing to sign. AppImage and `.deb` are the targets.

macOS builds must be made on macOS; the other two cross-build from anywhere.
