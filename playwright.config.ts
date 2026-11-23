import { defineConfig } from "@playwright/test";
import { PORT } from "./tests/e2e/port";

// models.js's e2e, headless Chromium: the store of made models on the browser's own private file
// system, from a worker. The server (tests/e2e/server.mjs) serves the built pages (dist-test/,
// `pnpm build:test`) at /, on models.js's own port (tests/e2e/port.ts).
export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "test-results/html" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" }, timeout: 60_000 }],
  webServer: {
    command: `node tests/e2e/server.mjs --port ${PORT} --dir dist-test`,
    url: `http://localhost:${PORT}/store.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
