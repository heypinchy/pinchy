import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    include: [
      "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-audit/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-context/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-docs/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-email/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-files/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-odoo/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-web/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    // Integration tests run against a real PostgreSQL database via
    // vitest.integration.config.ts (`pnpm test:db`). Excluded here so
    // `pnpm test` stays fast and Docker-free. Convention: any file named
    // *.integration.test.ts opts into the DB-backed runner.
    exclude: ["node_modules", "e2e", "**/*.integration.test.{ts,tsx,js,jsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "odoo-node": path.resolve(__dirname, "./node_modules/odoo-node"),
    },
  },
});
