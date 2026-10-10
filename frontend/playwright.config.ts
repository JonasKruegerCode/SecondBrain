import { defineConfig } from "@playwright/test";

// Run against the separately started managed API and Vite servers; no mocked requests.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "../.demo/browser-results",
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1000 },
    screenshot: "off",
    trace: "off",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    },
  },
});
