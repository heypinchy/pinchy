// The LibreOffice suites: every `src/**/*.libreoffice.test.ts`. They drive a
// real `soffice`, so they are excluded from `vitest.config.ts` and run here,
// through `pnpm test:libreoffice`, and in CI inside the Pinchy image the
// pipeline built (the LibreOffice that ships) — see the `libreoffice` job.
//
// One file at a time (`fileParallelism: false`): two LibreOffice first starts
// in parallel workers raced on one extension repository and one aborted
// (signal 6 in `syncRepositories`, LibreOffice 7.4.7), and under the default
// config they ran in parallel on any machine with `soffice` installed, which
// is where the 89 s / 180 s timeouts on a loaded laptop came from. A
// conversion batch takes minutes on a cold profile, so the timeouts are the
// suites' own, not the unit suite's 20 s.
//
// Without `soffice` every suite skips (`describe.skipIf`), so a developer
// without LibreOffice gets a green no-op. `KB_REQUIRE_SOFFICE=1` turns that
// skip into a failure; CI sets it. scripts/lib/libreoffice-suite.test.mjs pins
// this wiring.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.libreoffice.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
