// @ts-check
const { defineConfig, devices } = require("@playwright/test");

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
  },
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `${BASE}/origins/sources/`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      // Chromium mobile profile (avoids a separate WebKit browser download).
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});

