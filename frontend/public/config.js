// Same-origin default (dev + single-origin deploy). In production the nginx entrypoint
// (docker-entrypoint.d/50-outcome-config.sh) overwrites this from OUTCOME_* env vars.
window.__OUTCOME__ = {};
