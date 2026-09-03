'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell,
  desktopCapturer, nativeImage, protocol, net, nativeTheme,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_DIR = path.join(__dirname, '..', 'web');
// Runtime images live under electron/ because that is what ships. The packager's `files` list
// carries electron/, web/ and package.json — and NOT build/, which holds build-time resources
// the installer consumes. A path into build/ therefore resolves to nothing inside the asar,
// which is exactly how the tray icon came out blank: nativeImage answers a missing file with an
// empty image rather than an error, so the menu worked and the icon was simply invisible.
const ICON = path.join(__dirname, 'assets', 'app.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');

/** The SPA is served from here rather than file://. See registerAppProtocol below. */
const APP_ORIGIN = 'app://outcome';

let win = null;
let tray = null;
let quitting = false;
/** The push-to-talk key the user chose, whether or not it is registered right now. */
let pttAccelerator = null;
/** What is actually held with the OS at this moment — null whenever the window has focus. */
let pttRegistered = null;
/** Set once an update has been downloaded and is waiting for a restart. */
let updateReady = false;

// ── Single instance ──────────────────────────────────────────────────────────
// A messenger that opens a second copy of itself has two tray icons, two sockets and two
// sets of notifications. The second launch should raise the first window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // The deep link arrives as an argument to a SECOND launch on Windows and Linux: the browser
  // asks the OS to open outcome://…, the OS starts the app again, and the single-instance lock
  // bounces it here. Losing this handler means the SSO token silently never arrives.
  app.on('second-instance', (_e, argv) => {
    showWindow();
    handleDeepLink(argv.find((a) => a.startsWith('outcome://')));
  });
}

// ── outcome:// ───────────────────────────────────────────────────────────────
// Registering the scheme is what lets the OAuth callback come back to the app at all.
// In development the executable is electron.exe, so the OS has to be told which script it is
// launching or it registers Electron itself as the handler for every Outcome link on the
// machine.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('outcome', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('outcome');
}

// macOS delivers it as an event rather than an argument.
app.on('open-url', (e, url) => {
  e.preventDefault();
  showWindow();
  handleDeepLink(url);
});

/** `outcome://sso?token=…` (or `?error=…`) → the renderer. Anything else is ignored. */
function handleDeepLink(url) {
  if (!url) return;
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== 'outcome:') return;
  if (parsed.hostname !== 'sso') return;

  const payload = {
    token: parsed.searchParams.get('token') || '',
    error: parsed.searchParams.get('error') || '',
  };
  // The window may still be loading on a cold start — wait for it rather than firing into
  // nothing, which is how a token gets lost exactly once and is impossible to reproduce.
  const send = () => win?.webContents.send('outcome:sso', payload);
  if (win && !win.webContents.isLoading()) send();
  else win?.webContents.once('did-finish-load', send);
}

// ── The app:// protocol ──────────────────────────────────────────────────────
// Registered as *standard* and *secure* before the app is ready. Both matter:
//   • standard — so the SPA gets a real origin, and localStorage / IndexedDB persist. Under
//     file:// every reload starts with an empty origin and the user is signed out again.
//   • secure — getUserMedia refuses to run outside a secure context, so under file:// the
//     microphone simply never opens and calls look broken for no visible reason.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    // Server paths must 404 here, and this is not a formality. Without it the SPA-fallback
    // below answers /api/v1/auth/login with index.html, the client parses HTML as JSON, and
    // the user is told «Unexpected token '<'» — which says nothing about the real problem
    // (no server chosen yet). A 404 makes it a plain network failure instead.
    if (/^(api|livekit|uploads)(\/|$)/.test(rel)) {
      return new Response('not an Outcome instance', { status: 404 });
    }

    // The SPA is a single-page app: every path that is not a real file is its own route and
    // must be answered with index.html, or a reload on /app/settings 404s.
    if (!rel || !path.extname(rel)) rel = 'index.html';

    // Contain the path: a request for ../../etc/passwd must not escape the web directory.
    const target = path.join(WEB_DIR, rel);
    if (!target.startsWith(WEB_DIR)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0910', // matches the app's ground; kills the white flash on open
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // The key belongs to the renderer while the window is focused and to the OS otherwise —
  // see applyPushToTalk.
  win.on('focus', () => applyPushToTalk());
  win.on('blur', () => applyPushToTalk());

  // Closing the window keeps the app running in the tray — that is the whole point of a
  // desktop client for a messenger. Quitting is explicit, from the tray menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // Anything that is not our own origin opens in the user's browser. A messenger is full of
  // links other people wrote; following them inside the app shell would turn it into an
  // unsandboxed browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_ORIGIN)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // The renderer's console, in the shell's stdout. A packaged app has no devtools open and no
  // terminal of its own, so without this a failure inside the SPA is invisible: the window just
  // does the wrong thing quietly. Cheap, and it is what turned "the microphone does not work"
  // into an actual error message.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer] ${message}  (${source}:${line})`);
  });

  // OUTCOME_DIAG=1 asks the page what the media stack actually thinks. Behind a flag because
  // it opens the microphone to find out, and doing that on every launch would be rude.
  if (process.env.OUTCOME_DIAG) {
    win.webContents.once('did-finish-load', async () => {
      const report = await win.webContents.executeJavaScript(`(async () => {
        const out = {
          secureContext: window.isSecureContext,
          origin: location.origin,
          hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        };
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          out.inputs = devices.filter(d => d.kind === 'audioinput')
                              .map(d => ({ label: d.label, id: d.deviceId.slice(0, 8) }));
        } catch (e) { out.enumerateError = String(e); }
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          out.gotStream = s.getAudioTracks().map(t => ({ label: t.label, muted: t.muted, state: t.readyState }));
          s.getTracks().forEach(t => t.stop());
        } catch (e) { out.getUserMediaError = e.name + ': ' + e.message; }
        return out;
      })()`).catch((e) => ({ probeFailed: String(e) }));
      console.log('── media diagnostic ──\n' + JSON.stringify(report, null, 2));
    });
  }

  wireMediaPermissions(win.webContents.session);
  win.loadURL(APP_ORIGIN + '/index.html');
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── Media ────────────────────────────────────────────────────────────────────
function wireMediaPermissions(session) {
  // The OS already asked. Asking again inside the app would be a prompt the user cannot
  // answer meaningfully — Electron's dialog carries no origin they recognise.
  const ALLOWED = [
    'media', 'audioCapture', 'videoCapture',
    'display-capture', 'notifications', 'clipboard-sanitized-write',
  ];

  session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(ALLOWED.includes(permission));
  });

  // The other half, and the one that is easy to miss. getUserMedia does a SYNCHRONOUS check
  // in addition to the async request above, and this is what answers it. Electron's default
  // says no for a non-standard origin — which app:// is — so without this the microphone is
  // simply never granted: no prompt, no error worth reading, the call just has no audio.
  session.setPermissionCheckHandler((wc, permission) => ALLOWED.includes(permission));

  // Enumerating and opening a specific device (the input picker in settings) goes through a
  // third gate again. Same answer.
  session.setDevicePermissionHandler(() => true);

  // Screen sharing. Without a handler Electron denies getDisplayMedia outright and the share
  // button does nothing at all. Deliberately NOT useSystemPicker: the OS chooser exists only
  // on Windows 11 and offers no way to say whether sound goes with the picture, so half the
  // platforms would fall through to a callback that has to choose blindly anyway. One chooser
  // that behaves the same everywhere beats a good one on one OS.
  session.setDisplayMediaRequestHandler((_request, callback) => openSourcePicker(callback));
}

// ── The screen-share chooser ─────────────────────────────────────────────────
// getDisplayMedia is answered by the main process, and the answer must name a source, so this
// window IS the chooser — there is nothing to defer to. It lives in its own window rather than
// being drawn by the app: the list holds thumbnails of every window on the machine, including
// other people's, and that is not content to hand to the renderer running the messenger.

let pickerWin = null;
/** Set while the chooser is open; the pending getDisplayMedia callback, guarded to fire once. */
let pickerAnswer = null;

function openSourcePicker(callback) {
  // Exactly one answer per request, whatever happens to the window. getDisplayMedia never
  // times out: miss the callback and the share button stays stuck with no error, forever.
  let settled = false;
  const answer = (streams) => {
    if (settled) return;
    settled = true;
    try {
      callback(streams);
    } catch (err) {
      // Electron validates the answer and throws on a malformed one. Swallowing that would
      // leave getDisplayMedia pending forever with nothing on screen and nothing in the log —
      // which is exactly how the audio key above went unnoticed. Deny instead, loudly.
      console.error('[picker] Electron refused the chosen source', err);
      try { callback({}); } catch { /* the request is already past saving */ }
    }
  };

  // A second request while the chooser is open would stack a second chooser on the first.
  if (pickerWin) {
    pickerWin.focus();
    return answer({});
  }

  pickerAnswer = answer;
  pickerWin = new BrowserWindow({
    parent: win,
    modal: true,
    show: false,
    width: 840,
    height: 620,
    minWidth: 560,
    minHeight: 440,
    title: 'Выберите, чем поделиться',
    backgroundColor: '#141118',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const w = pickerWin;
  w.once('ready-to-show', () => w.show());

  // Every route out of the window lands here — the X, Escape, the parent closing. Denying on
  // close is what makes cancelling work at all; the chosen path settles first and this is then
  // a no-op.
  w.on('closed', () => {
    answer({});
    pickerWin = null;
    pickerAnswer = null;
  });

  w.loadFile(path.join(__dirname, 'picker.html'));
}

function wirePickerIpc() {
  // Every handler checks the sender. These are global channels: the app renderer could call
  // them too, and it has no business enumerating the user's open windows.
  const fromPicker = (e) => pickerWin !== null && e.sender === pickerWin.webContents;

  ipcMain.handle('picker:sources', async (e) => {
    if (!fromPicker(e)) return [];
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.name) // untitled windows are toolbars and popups, not things to share
      .map((s) => ({
        id: s.id,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        name: s.name,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });

  ipcMain.on('picker:choose', async (e, { id, audio }) => {
    if (!fromPicker(e)) return;
    // Re-fetch rather than trusting the id blindly: the window may have closed while the user
    // was deciding, and a stale id produces a black track instead of an honest failure. No
    // thumbnails this time — they were only ever for the list.
    const sources = await desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .catch(() => []);
    const chosen = sources.find((s) => s.id === id);
    const streams = chosen ? { video: chosen } : {};
    // The key must be ABSENT, not present-and-undefined: Electron validates that `audio` is a
    // WebFrameMain or one of the loopback strings the moment the property exists, so
    // `audio: undefined` throws and the share silently produces nothing. Loopback is Windows-only.
    if (chosen && audio && process.platform === 'win32') streams.audio = 'loopback';
    pickerAnswer?.(streams);
    if (!e.sender.isDestroyed()) pickerWin?.close();
  });

  ipcMain.on('picker:cancel', (e) => {
    if (!fromPicker(e)) return;
    pickerWin.close(); // the 'closed' handler above is what actually denies the request
  });
}


// ── Self-update ──────────────────────────────────────────────────────────────
// Checks the same directory the landing page downloads from, so a release is one upload
// rather than two places to keep in step.
//
// NOT every package can do this, and the difference is not a limitation of the updater:
//
//   • Windows installer — downloads the new installer and runs it on quit.
//   • AppImage — replaces the file in place, which is why it needs to be writable by the
//     user running it. Installed system-wide by root, the check still runs and the swap
//     fails; that is why the failure is reported rather than swallowed.
//   • .deb — deliberately excluded. Those files belong to the package manager: replacing
//     them behind apt's back leaves the two disagreeing about what is installed, and the
//     next `apt upgrade` undoes it. Debian packages update from a repository, which is a
//     different piece of infrastructure than a file on a website. The landing page says so.
function wireAutoUpdate() {
  if (!app.isPackaged) return;                                   // dev runs have no version to beat
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;  // .deb — see above

  // A Store build must never update itself: Microsoft ships updates through the Store, and an
  // app that replaces its own files there fails certification and cannot write to its install
  // location anyway. Electron sets this flag only when the app runs as a packaged Store app,
  // so it is the identity of the install talking, not a build-time guess.
  if (process.windowsStore) {
    console.log('[update] Store build — updates come from the Store');
    return;
  }

  // The Windows updater knows one format: it downloads the NSIS installer and runs it. An MSI
  // install is owned by Windows Installer, exactly as a .deb is owned by apt — running the NSIS
  // installer over it would leave a SECOND copy beside the first, while the entry in "Programs
  // and Features" still pointed at the old one. The NSIS uninstaller sitting next to the
  // executable is what tells the two apart: an MSI install does not create one.
  if (process.platform === 'win32'
      && !require('node:fs').existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall Outcome.exe'))) {
    console.log('[update] MSI install — updates come from the installer, not from here');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    refreshTrayMenu();
    console.log(`[update] ${info.version} ready — installs on quit`);
  });
  // Loud, because a silent updater that has been failing for months looks identical to one
  // that has simply had nothing to do.
  autoUpdater.on('error', (err) => console.error('[update] check failed', err));

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* reported by the handler */ });
  check();
  // A messenger stays open for weeks; without a repeat check only a restart would ever
  // notice a release.
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  // A 16px icon drawn as 16px, with @2x and @3x beside it for scaled displays — nativeImage
  // picks the representation by the display's scale factor. Shrinking the 512px app icon at
  // runtime instead, as this used to, turns the mark into a smudge at the size that matters.
  const image = nativeImage.createFromPath(TRAY_ICON);
  if (image.isEmpty()) {
    // Say so. An empty image is a perfectly legal Tray argument and produces an invisible icon
    // with a working menu: a bug that reads as a Windows quirk and can hide for weeks.
    console.error(`[tray] icon missing or unreadable: ${TRAY_ICON}`);
  }
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Outcome');
  refreshTrayMenu();
  tray.on('click', () => showWindow());
}

/** Rebuilt rather than mutated: a Menu is a snapshot, so a downloaded update only shows up
 *  here if the whole template is built again. */
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Outcome', click: () => showWindow() },
    ...(updateReady
      ? [{ type: 'separator' }, {
          label: 'Перезапустить и обновить',
          click: () => { quitting = true; autoUpdater.quitAndInstall(); },
        }]
      : []),
    { type: 'separator' },
    {
      label: 'Запускать при входе в систему',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Выйти', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ── Push-to-talk ─────────────────────────────────────────────────────────────
// The reason this app exists. In a browser the PTT key only works while the tab has focus
// (see GlobalKeybinds.tsx) — which is exactly when you are NOT in the window you are talking
// about.
//
// REGISTERED ONLY WHILE THE WINDOW IS UNFOCUSED, and that is not an optimisation.
// globalShortcut CONSUMES the key everywhere, our own window included: with PTT bound to "M",
// the letter M stopped reaching the message box — the OS handed it to the shortcut instead.
// Reported from use, and it would have happened with any key.
//
// Splitting it by focus makes the two halves complementary instead of overlapping. Focused,
// the in-window handler owns the key and gives real hold-to-talk, because a renderer sees key
// UP as well as key down. Unfocused, the global one takes over — and there it can only be a
// toggle, since globalShortcut reports presses and not releases.
//
// What this still does NOT fix: while Outcome is in the background the key is swallowed in
// OTHER applications too. A key that also types is a poor choice for this; a real fix needs a
// native keyboard hook that passes the keystroke through. See README.md.
function applyPushToTalk() {
  if (pttRegistered) {
    globalShortcut.unregister(pttRegistered);
    pttRegistered = null;
  }
  // Nothing chosen, or the window has focus and the renderer is handling it.
  if (!pttAccelerator || win?.isFocused()) return true;
  try {
    const ok = globalShortcut.register(pttAccelerator, () => {
      win?.webContents.send('outcome:ptt-toggle');
    });
    if (ok) pttRegistered = pttAccelerator;
    return ok;
  } catch {
    return false;
  }
}

function setPushToTalk(accelerator) {
  pttAccelerator = accelerator || null;
  return applyPushToTalk();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Windows draws the caption bar from the SYSTEM theme, not the page — so a light-themed
  // Windows put a white strip above a near-black app and the window read as two halves glued
  // together. This makes the OS draw it dark. It is not the same as a frameless window with
  // the app's own colour, but it keeps the native buttons and cannot cover the app's own
  // top-right controls, which a title-bar overlay at this header height would.
  nativeTheme.themeSource = 'dark';

  // Windows resolves a notification's app name and icon through the AppUserModelID, and
  // Electron's default is "electron.app.<name>" — which is literally what the toast showed
  // instead of "Outcome", with no icon beside it. The installer registers the Start-menu
  // shortcut under the appId, and Windows matches the two by exact string, so this must stay
  // identical to `build.appId` in package.json.
  if (process.platform === 'win32') app.setAppUserModelId('ru.outcome.desktop');

  registerAppProtocol();
  createWindow();
  createTray();
  wirePickerIpc();

  wireAutoUpdate();

  ipcMain.handle('outcome:set-ptt', (_e, accelerator) => setPushToTalk(accelerator));
  ipcMain.handle('outcome:open-external', (_e, url) => {
    // Only ever hand the OS an http(s) URL. The renderer is full of text other people wrote,
    // and shell.openExternal on an arbitrary scheme is a way to launch things.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return true;
    }
    return false;
  });

  // A cold start where the app itself was launched BY the deep link: the URL is in argv of
  // this first process, not of a second one.
  handleDeepLink(process.argv.find((a) => a.startsWith('outcome://')));
  ipcMain.handle('outcome:set-badge', (_e, count) => {
    // Linux and macOS show a dock/launcher count; Windows has no equivalent for a number,
    // so there the tray tooltip carries it.
    if (process.platform === 'win32') {
      tray?.setToolTip(count > 0 ? `Outcome — ${count} непрочитанных` : 'Outcome');
    } else {
      app.setBadgeCount(Number(count) || 0);
    }
    return true;
  });

  app.on('activate', () => showWindow()); // macOS dock click
});

app.on('window-all-closed', () => {
  // Deliberately does NOT quit: the tray keeps the session alive so calls and notifications
  // keep arriving after the window is closed.
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
