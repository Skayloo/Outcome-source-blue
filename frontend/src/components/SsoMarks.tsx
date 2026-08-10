/**
 * Provider brand marks for the SSO buttons. Inline SVG (no remote assets — the CSP
 * forbids third-party origins, and a login screen must not phone home before login).
 * Google's official white-on-dark G (its branding rules allow this variant, and only
 * this one, on a dark surface); Yandex's is its red "Я" lockup.
 */

export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#fff" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.1z" />
      <path fill="#fff" d="M24 46c6 0 11-2 14.6-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.7-3.9-12.4-9.1H4.3v5.7C7.9 41.1 15.4 46 24 46z" />
      <path fill="#fff" d="M11.6 28.1c-.4-1.3-.7-2.7-.7-4.1s.2-2.8.7-4.1v-5.7H4.3C2.8 17.1 2 20.4 2 24s.8 6.9 2.3 9.8l7.3-5.7z" />
      <path fill="#fff" d="M24 10.8c3.3 0 6.2 1.1 8.5 3.3l6.3-6.3C35 4.2 30 2 24 2 15.4 2 7.9 6.9 4.3 14.2l7.3 5.7c1.7-5.2 6.6-9.1 12.4-9.1z" />
    </svg>
  );
}

export function YandexMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#FC3F1D" />
      <path
        fill="#fff"
        d="M13.3 18.6h2.2V5.4h-3.2c-3.2 0-4.9 1.7-4.9 4.1 0 1.9.9 3.1 2.5 4.2l-2.8 4.9h2.4l3.1-5.5-1.1-.7c-1.3-.9-1.9-1.6-1.9-3.1 0-1.3.9-2.2 2.6-2.2h1.1v11.5z"
      />
    </svg>
  );
}
