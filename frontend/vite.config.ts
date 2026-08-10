import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// React SPA. During `npm run dev`, API/WS/LiveKit/uploads are proxied to the backend on :5000
// so the dev server behaves same-origin (matching the nginx reverse-proxy used in the container).
export default defineConfig({
  plugins: [react()],
  define: {
    __OUTCOME_EDITION__: JSON.stringify("blue"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@lib": resolve(__dirname, "src/lib"),
      "@stores": resolve(__dirname, "src/stores"),
      "@components": resolve(__dirname, "src/components"),
      "@pages": resolve(__dirname, "src/pages"),
      "@styles": resolve(__dirname, "src/styles"),
    },
  },
  build: {
    cssCodeSplit: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:5000", changeOrigin: true, ws: true },
      "/livekit": { target: "http://localhost:5000", changeOrigin: true, ws: true },
      "/uploads": { target: "http://localhost:5000", changeOrigin: true },
    },
  },
});
