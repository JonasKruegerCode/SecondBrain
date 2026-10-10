import { defineConfig } from "vite";

// Read API_PORT from environment — useful when dev runs on a different port
// than prod (e.g. API_PORT=8001 in .env to develop alongside a running Docker stack).
const apiPort = process.env.API_PORT ?? "8000";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        // Preserve browser host for the managed API's same-origin write guard.
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        wiki: new URL("./index.html", import.meta.url).pathname,
        legacy: new URL("./legacy.html", import.meta.url).pathname,
      },
    },
  },
});
