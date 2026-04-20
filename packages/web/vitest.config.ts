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
      "../plugins/pinchy-odoo/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../plugins/pinchy-docs/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    exclude: ["node_modules", "e2e"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "odoo-node": path.resolve(__dirname, "./node_modules/odoo-node"),
      "@pinchy/openai-subscription-oauth": path.resolve(
        __dirname,
        "../openai-subscription-oauth/src/index.ts"
      ),
    },
  },
});
