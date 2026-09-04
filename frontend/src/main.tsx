import ReactDOM from "react-dom/client";
import "@styles/fonts.css";
import "@styles/tokens.css";
import "@styles/base.css";
import "@styles/login.css";
import "@styles/app.css";
import "@styles/theme-neon-glow.css";
import "@styles/theme-midnight.css";
import "@styles/theme-deep-ink.css";
import "@styles/theme-light.css";
import "@styles/root.css";
import "@styles/panes.css";
import "@styles/glass.css";
import "@styles/motion.css";
import "@styles/responsive.css";
import { App } from "./App";
import { prefetchDeepFilter } from "@lib/noise-suppression-dfn";
import { loadPref } from "@components/settings/helpers";
import { migrateLegacyPrefs } from "@components/settings/helpers";
import { applyAllPreferences } from "@lib/applyPreferences";

// Migrate any legacy prefs, then apply all persisted preferences before first paint.
migrateLegacyPrefs();
applyAllPreferences();

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

// DeepFilterNet is 24 MB and is no longer the default filter, so it is pulled down only for
// the people who actually chose it. Everyone else runs RNNoise, which ships with the bundle.
// Idle-time and fire-and-forget: it must not compete with anything the app is doing.
if (loadPref<string>("nsEngine", "rnnoise") === "deepfilter") {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => void prefetchDeepFilter());
  else setTimeout(() => void prefetchDeepFilter(), 4000);
}
