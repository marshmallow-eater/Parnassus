import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Serves the renderer alone in a plain browser. There is no Electron preload
// in this mode, so the renderer falls back to the in-memory mock bridge and
// never touches the real filesystem. Playwright runs against this server.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src/renderer"),
  resolve: {
    alias: { "@shared": resolve(__dirname, "src/shared") },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
