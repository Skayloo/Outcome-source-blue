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

/**
 * The intro video at the top of the landing (#intro-video). The markup alone is a complete
 * player: poster, the browser's controls, preload="none", so with JavaScript off nothing is
 * downloaded until someone presses play. This only starts it — muted, never with sound — once
 * at least half of it is on screen, and pauses it again when it scrolls away.
 *
 * Not started at all for prefers-reduced-motion (a looping film is exactly what that setting
 * asks to be spared) or Save-Data (3 MB nobody asked for). A reader who paused it by hand keeps
 * it paused: scrolling back does not overrule them.
 */
document.addEventListener("DOMContentLoaded", function () {
  var video = document.getElementById("intro-video");
  if (!video || !("IntersectionObserver" in window)) return;
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (navigator.connection && navigator.connection.saveData) return;
  } catch (e) {
    return;
  }

  var ours = false;      // the current pause is one we made, not the reader's
  var heldByUser = false;

  video.addEventListener("pause", function () {
    if (ours) { ours = false; return; }
    if (!video.ended) heldByUser = true;
  });
  video.addEventListener("play", function () { heldByUser = false; });

  new IntersectionObserver(function (entries) {
    var visible = entries[0].isIntersecting;
    if (visible && video.paused && !heldByUser) {
      // Muted by the markup: autoplay is only allowed muted, and the owner wants it silent.
      // A reader who turned the sound on keeps it on when they scroll back.
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* blocked — the poster and controls remain */ });
    } else if (!visible && !video.paused) {
      ours = true;
      video.pause();
    }
  }, { threshold: 0.5 }).observe(video);
});
