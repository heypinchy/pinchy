import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";
import requireAuditLog from "./eslint-rules/require-audit-log.js";
import requireParseRequestBody from "./eslint-rules/require-parse-request-body.js";
import noDirectSession from "./eslint-rules/no-direct-session.js";
import noPiiInAuditDetail from "./eslint-rules/no-pii-in-audit-detail.js";
import noUntrackedSkips from "./eslint-rules/no-untracked-skips.js";

const pinchyPlugin = {
  rules: {
    "require-audit-log": requireAuditLog,
    "no-direct-session": noDirectSession,
    "no-pii-in-audit-detail": noPiiInAuditDetail,
    "require-parse-request-body": requireParseRequestBody,
    "no-untracked-skips": noUntrackedSkips,
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  security.configs.recommended,
  // Relax rules for generated/third-party UI components (shadcn, assistant-ui)
  {
    files: ["src/components/ui/**", "src/components/assistant-ui/**"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "@next/next/no-img-element": "off",
      "security/detect-object-injection": "off",
    },
  },
  // Allow `any` in test files (mocks often need it)
  {
    files: ["src/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Pinchy custom rules — broad scope (PII detection wherever appendAuditLog
  // is called):
  // - no-pii-in-audit-detail: forbid plaintext `email:` / `emailAddress:`
  //   keys inside appendAuditLog(...) detail (GDPR Art. 17 — see #238).
  //   Applies to API routes, lib/, and server/ because appendAuditLog is
  //   also called from helpers (e.g. lib/auth.ts, server/client-router.ts).
  {
    files: ["src/app/api/**/route.ts", "src/lib/**/*.ts", "src/server/**/*.ts"],
    plugins: { pinchy: pinchyPlugin },
    rules: {
      "pinchy/no-pii-in-audit-detail": "error",
    },
  },
  // Pinchy custom rules — repo-wide (the fire-and-forget ban must reach
  // every source file, not just route handlers):
  // - require-audit-log: every state-changing route handler must call
  //   appendAuditLog or deferAuditLog (or set a // audit-exempt: <reason>
  //   file comment). Also forbids fire-and-forget `.catch()` chained
  //   directly onto appendAuditLog calls in any source file (see #231).
  //   The route-handler check is gated by file path inside the rule itself;
  //   the fire-and-forget check applies to every source file.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { pinchy: pinchyPlugin },
    rules: {
      "pinchy/require-audit-log": "error",
    },
  },
  // Pinchy custom rules — every test file in the repo:
  // - no-untracked-skips: forbid permanent test skips (`.skip`, `.todo`,
  //   `.fixme`, `xit`, `xdescribe`) unless the leading 40 lines contain a
  //   tracking-issue reference (`#NNN` or a github.com issue URL). The
  //   companion vitest drift-guard in
  //   src/__tests__/lib/no-untracked-skips.test.ts enforces the same
  //   contract at test time. `.skipIf(...)` is always allowed.
  {
    files: [
      "src/**/*.{test,spec}.{ts,tsx,js,jsx}",
      "../**/*.{test,spec}.{ts,tsx,js,jsx}",
      "e2e/**/*.{ts,tsx,js,jsx}",
    ],
    plugins: { pinchy: pinchyPlugin },
    rules: {
      "pinchy/no-untracked-skips": "error",
    },
  },
  // Pinchy custom rules — API route handlers only:
  // - no-direct-session: every protected route must use the centralized
  //   helpers in @/lib/api-auth (withAuth / withAdmin / requireAdmin) instead
  //   of calling getSession or auth.api.getSession directly
  //   (opt out with a // auth-direct: <reason> file comment)
  // - require-parse-request-body: every state-mutating handler must use
  //   parseRequestBody() from @/lib/api-validation instead of calling
  //   request.json() directly
  {
    files: ["src/app/api/**/route.ts"],
    plugins: { pinchy: pinchyPlugin },
    rules: {
      "pinchy/no-direct-session": "error",
      "pinchy/require-parse-request-body": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
