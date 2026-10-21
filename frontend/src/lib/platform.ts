/** iPhone or iPad — every browser there is WebKit, and iPadOS reports itself as a Mac with touch.
 *  Used where iOS audio differs: it ignores an <audio> element's volume (livekitSession, the
 *  guest page). */
export function isIosWebKit(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
