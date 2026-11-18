import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
  },
  webServer: {
    command: "bun run dev:web",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
