/**
 * The app moved to /app so that "/" could become a page a crawler can actually read. Two
 * kinds of visitor still legitimately arrive at "/" and must not be shown marketing:
 *
 *   1. Someone already signed in, whose muscle memory (and bookmark) says outcome.ru.
 *   2. The OAuth callback. The server hands the token back as {origin}/#sso=TOKEN and has
 *      no way to know this origin keeps its app one level down — tenant subdomains serve
 *      the app at "/" and must keep getting that URL. So the forwarding belongs here.
 *
 * A crawler has neither a session nor a fragment, so it stays and reads the page. This runs
 * from a blocking <script> in <head>, before the first paint, so a forwarded visitor never
 * sees the landing flash past.
 *
 * External rather than inline because the page ships under script-src 'self', and a CSP
 * hash on inline code silently stops matching the moment anyone edits a character of it.
 */
(function () {
  var hash = window.location.hash;

  // Fragment intact: the token only exists there, and it is what the app is waiting for.
  if (hash.indexOf("#sso") === 0) {
    window.location.replace("/app" + hash);
    return;
  }

  // localStorage throws outright in a few privacy configurations rather than returning null.
  // Failing to forward is a landing page; failing loudly is a blank one.
  try {
    if (window.localStorage.getItem("outcome:session")) window.location.replace("/app");
  } catch (e) {
    /* no stored session we can see — show the landing */
  }
})();
