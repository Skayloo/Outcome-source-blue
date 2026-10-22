import { useEffect, useRef, useState } from "react";
import { authStore } from "@stores/auth.store";
import { useStoreState } from "@lib/useStore";
import { restoreSession, hasStoredSession, clearStoredSession } from "@lib/session";
import { api, ws } from "@lib/services";
import { useT } from "@lib/i18n";
import { BootSplash } from "@components/BootSplash";
import { ConnectPage } from "@pages/ConnectPage";
import { MainPage } from "@pages/MainPage";
import { AdminPage, AdminDenied } from "@pages/AdminPage";
import { GuestVoicePage } from "@pages/GuestVoicePage";
import { isSpaceAdmin } from "@lib/access";

/** Stop waiting on a silent server and let the user sign in by hand. */
const BOOT_TIMEOUT_MS = 8_000;

export function App() {
  const auth = useStoreState(authStore);
  useT(); // re-render the whole tree when the UI language changes
  const booted = useRef(false);
  const wasAuthed = useRef(false);
  // Was there a session to restore when the page loaded? Only used to arm the boot timeout.
  const hadSessionAtBoot = useRef(hasStoredSession());
  const [bootTimedOut, setBootTimedOut] = useState(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    if (!authStore.getState().isAuthenticated) restoreSession();
  }, []);

  useEffect(() => {
    if (!hadSessionAtBoot.current) return;
    const id = setTimeout(() => setBootTimedOut(true), BOOT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    // If auth was cleared (e.g. a 401), tear down the WS + stored session.
    if (wasAuthed.current && !auth.isAuthenticated) {
      ws.disconnect();
      clearStoredSession();
    }
    wasAuthed.current = auth.isAuthenticated;
  }, [auth.isAuthenticated]);

  // Guest voice links are for people WITHOUT accounts — the page renders before any
  // auth gating and never touches the app's session machinery.
  const guestMatch = window.location.pathname.match(/^\/guest\/([A-Za-z0-9]+)/);
  if (guestMatch) return <GuestVoicePage code={guestMatch[1]!} />;

  if (!auth.isAuthenticated) {
    // Re-authenticating a stored session — show the brand, not a sign-in form the user never
    // asked for. Give way the moment the server rejects the token, or if it stays silent long
    // enough that a manual sign-in is the better offer.
    //
    // Re-read the stored session on EVERY render rather than latching it at mount: logout()
    // removes it before clearing auth, so the sign-in form must come straight back. Latching
    // it made logout sit on the splash until the boot timeout — an eight-second sign-out.
    const signingBackIn = hasStoredSession() && !auth.sessionInvalid && !bootTimedOut;
    return signingBackIn ? <BootSplash /> : <ConnectPage />;
  }

  // Dedicated /admin route: the space's administrators (Owner and Admin of the SPACE — not the
  // owner of some server, which is what the old `role === "owner"` let in, while shutting out a
  // space Admin the API itself accepts).
  const path = window.location.pathname;
  if (path === "/admin" || path.startsWith("/admin/")) {
    return isSpaceAdmin(auth.user) ? <AdminPage /> : <AdminDenied />;
  }

  return <MainPage />;
}
