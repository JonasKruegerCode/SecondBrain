import { defineConfig } from "vite";

// Read API_PORT from environment — useful when dev runs on a different port
// than prod (e.g. API_PORT=8001 in .env to develop alongside a running Docker stack).
const apiPort = process.env.API_PORT ?? "8000";

export default defineConfig(({ mode }) => ({
  server: {
    port: 5173,
    // A demo service restart must not reload the tab and discard an open draft.
    // Ordinary `npm run dev` keeps Vite hot reload enabled.
    hmr: mode === "demo" ? false : undefined,
    ws: mode === "demo" ? false : undefined,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        // Preserve browser host for the managed API's same-origin write guard.
        changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyReq", (upstream, request, response) => {
            if (request.method !== "POST" || request.url?.split("?")[0] !== "/api/wiki/chat") return;
            // A fully received POST can still lose its waiting browser before
            // upstream headers arrive. Vite's proxyRes hook starts too late.
            const disconnected = () => {
              if (!response.writableEnded) upstream.destroy();
            };
            response.once("close", disconnected);
            upstream.once("close", () => response.off("close", disconnected));
            if (response.destroyed) disconnected();
          });
        },
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
}));
