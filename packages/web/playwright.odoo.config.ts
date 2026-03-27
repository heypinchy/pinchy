import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/odoo",
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
  },
});
