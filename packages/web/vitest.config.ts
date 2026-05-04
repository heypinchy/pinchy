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
      // Contract tests for all Pinchy plugins — validate the emitted config shape
      // against each plugin's openclaw.plugin.json manifest. These files only import
      // from @pinchy/web helpers and have no heavy plugin-specific native deps.
      "../plugins/pinchy-audit/config-schema.test.ts",
      "../plugins/pinchy-context/config-schema.test.ts",
      "../plugins/pinchy-docs/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-email/config-schema.test.ts",
      "../plugins/pinchy-files/config-schema.test.ts",
      "../plugins/pinchy-odoo/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-web/config-schema.test.ts",
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
