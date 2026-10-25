import { defineConfig } from "@playwright/test";

// The journeys share one simulated data folder and one application, so they run one at a time.
// The harness writes its own failure screenshot and logs; CI uploads only *.png and *.log.
export default defineConfig({
  testDir: "./tests/real-app",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 600_000,
  expect: { timeout: 30_000 },
  outputDir: "test-results/real-app",
  reporter: "line",
  use: { screenshot: "off", trace: "off", video: "off" },
});
