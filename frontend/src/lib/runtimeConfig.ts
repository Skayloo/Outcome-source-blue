/**
 * Runtime endpoint config for the web SPA.
 *
 * A static build is one artifact deployed to many domains, so it can't bake endpoints in at
 * build time (that's the mobile app's `--dart-define`). Instead nginx writes `/config.js` from
 * container env vars at startup (see docker-entrypoint.d/50-outcome-config.sh), which sets
 * `window.__OUTCOME__`. Empty/unset → same-origin (the default single-origin deployment).
 *
 * Use for a per-service subdomain ingress:
 *   OUTCOME_API_BASE=https://api.outcome.io/api/v1
 *   OUTCOME_WS_URL=wss://ws.outcome.io/api/v1/ws
 *   OUTCOME_LIVEKIT_URL=wss://livekit.outcome.io
 * (the UI itself lives at the root domain, e.g. outcome.io). The API host then needs CORS for
 * the UI origin.
 */
export interface OutcomeRuntimeConfig {
  apiBase?: string;
  wsUrl?: string;
  livekitUrl?: string;
}

declare global {
  interface Window {
    __OUTCOME__?: OutcomeRuntimeConfig;
  }
}

function cfg(): OutcomeRuntimeConfig {
  return (typeof window !== "undefined" && window.__OUTCOME__) || {};
}

/** A trimmed non-empty override, or null when unset (envsubst leaves an empty string). */
function val(v: string | undefined): string | null {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
}

export function runtimeApiBase(): string | null {
  return val(cfg().apiBase);
}
export function runtimeWsUrl(): string | null {
  return val(cfg().wsUrl);
}
export function runtimeLivekitUrl(): string | null {
  return val(cfg().livekitUrl);
}
