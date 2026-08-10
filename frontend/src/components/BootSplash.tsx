/**
 * BootSplash — shown while a stored session is being re-authenticated.
 *
 * Without it the app flashed the LOGIN FORM on every reload: `isAuthenticated` only flips
 * on the server's auth_ok, a whole WS round-trip after the page renders, so React honestly
 * drew "signed out" the entire time. Knowing a token exists is synchronous, so the correct
 * state to draw is "signing you back in" — this.
 *
 * Both variants animate the LOGO ITSELF rather than parking a generic spinner beside it.
 * The mark's ring is an arc with a 70° gap in the top-right, and the brand's dot lives
 * exactly in that gap — so the gap is the dot's home, and both animations are built around
 * that fact:
 *
 *   "orbit" — the dot circles the ring continuously, swelling as it sweeps its home.
 *   "bloom" — the dot runs the ring, then blooms and contracts when it reaches the gap,
 *             before setting off again. The pause reads as the mark completing itself.
 */
export type SplashVariant = "orbit" | "bloom";

export function BootSplash({ variant = "bloom" }: { variant?: SplashVariant } = {}) {
  return (
    <div className="boot-splash">
      <div className={`boot-mark boot-${variant}`}>
        <svg viewBox="0 0 64 64" width="96" height="96" aria-hidden="true">
          <defs>
            <linearGradient id="boot-grad" x1="14" y1="52" x2="52" y2="14" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#7b2fff" />
              <stop offset="1" stopColor="#00c8ff" />
            </linearGradient>
            <filter id="boot-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.6" />
            </filter>
          </defs>

          {/* The ring, breathing softly. */}
          <g className="boot-ring">
            <g opacity="0.5" filter="url(#boot-glow)">
              <path
                d="M48.74 29.05 A17 17 0 1 1 34.95 15.26"
                stroke="url(#boot-grad)"
                strokeWidth="5.5"
                strokeLinecap="round"
                fill="none"
              />
            </g>
            <path
              d="M48.74 29.05 A17 17 0 1 1 34.95 15.26"
              stroke="url(#boot-grad)"
              strokeWidth="5.5"
              strokeLinecap="round"
              fill="none"
            />
          </g>

          {/* The dot, at its home in the ring's gap (cx/cy match the static logo exactly).
              The group spins it around the ring's centre; the circle itself only scales. */}
          <g className="boot-orbit">
            <circle className="boot-dot" cx="44" cy="20" r="5" fill="#00c8ff" />
          </g>
        </svg>
      </div>
    </div>
  );
}
