import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SPA config (kept under web/ so it never collides with the root vitest config).
// root "." = this web/ directory; build → web/dist (served by src/server/server.ts).
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
});
