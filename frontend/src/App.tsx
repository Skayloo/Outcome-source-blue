import { useEffect, useRef, useState } from "react";
import { authStore } from "@stores/auth.store";
import { SetPasswordGate } from "@components/SetPasswordGate";
import { useStoreState } from "@lib/useStore";
import { restoreSession, hasStoredSession, clearStoredSession } from "@lib/session";
import { consumeSsoRedirect, wireDesktopSso } from "@lib/sso";
import { setTransientError } from "@stores/ui.store";
import { ws } from "@lib/services";
import { useT, t } from "@lib/i18n";
import { BootSplash } from "@components/BootSplash";
import { ConnectPage } from "@pages/ConnectPage";
import { MainPage } from "@pages/MainPage";
import { AdminPage, AdminDenied } from "@pages/AdminPage";
import { GuestVoicePage } from "@pages/GuestVoicePage";
import { PrivacyPage } from "@pages/PrivacyPage";
import { loadSpace } from "@lib/space";

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
    // A token handed back by the SSO callback (#sso=…) outranks any stored session:
    // the user just deliberately signed in as somebody.
    const ssoError = consumeSsoRedirect();
    if (ssoError !== null) setTransientError(t("auth.ssoFailed"));
    // The same token, arriving the other way. In the desktop shell the round-trip happens in
    // the user's browser and comes back over the outcome:// scheme, so there is no fragment to
    // read — the shell hands it over instead. No-op in a browser.
    wireDesktopSso(() => setTransientError(t("auth.ssoFailed")));
    if (!authStore.getState().isAuthenticated) restoreSession();
    // Not for the branding here — for the noindex a tenant's pages need. Asking on mount means
    // it happens whichever page a crawler landed on, not only the ones that show a logo.
    void loadSpace();
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

  // Public and above the auth gate on purpose: the people who most need to read this are the
  // ones deciding whether to sign up, plus an App Review reviewer with no account at all.
  if (window.location.pathname.replace(/\/$/, "") === "/privacy") return <PrivacyPage />;

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

  // Dedicated /admin route: a separate owner-only dashboard, not the in-app modal.
  const path = window.location.pathname;
  if (path === "/admin" || path.startsWith("/admin/")) {
    const isOwner = (auth.user?.role ?? "").toLowerCase() === "owner";
    return isOwner ? <AdminPage /> : <AdminDenied />;
  }

  // Every authenticated route goes through here: an account created by a provider sign-in
  // has no password, and a password is what the iOS app needs to let them in and what the
  // key backup is wrapped with. No password, no app.
  return <SetPasswordGate><MainPage /></SetPasswordGate>;
}
