import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "capture.ts",
  fullyParallel: false,
  retries: 1,
  workers: 1,
  timeout: 60000,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:7777",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
