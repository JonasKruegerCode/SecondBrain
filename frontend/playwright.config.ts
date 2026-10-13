import { defineConfig } from "@playwright/test";

const browserName = process.env.PLAYWRIGHT_BROWSER_ENGINE || "chromium";
if (browserName !== "chromium" && browserName !== "webkit") throw new Error("Unsupported browser engine");

// Run against the separately started managed API and Vite servers; no mocked requests.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "../.demo/browser-results",
  workers: 1,
  retries: 0,
  reporter: [["dot"], ["./e2e/save-body-reporter.ts"]],
  use: {
    browserName,
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1000 },
    screenshot: "off",
    trace: "off",
    launchOptions: browserName === "chromium" ? {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    } : {},
  },
});
