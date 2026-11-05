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
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
