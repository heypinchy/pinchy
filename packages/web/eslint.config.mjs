import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";
import requireAuditLog from "./eslint-rules/require-audit-log.js";
import noDirectSession from "./eslint-rules/no-direct-session.js";
import noPiiInAuditDetail from "./eslint-rules/no-pii-in-audit-detail.js";

const pinchyPlugin = {
  rules: {
    "require-audit-log": requireAuditLog,
    "no-direct-session": noDirectSession,
    "no-pii-in-audit-detail": noPiiInAuditDetail,
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
  // Pinchy custom rules — broad scope.
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
  // Pinchy custom rules — API route handlers only:
  // - require-audit-log: every state-changing handler must call appendAuditLog
  //   (or set a // audit-exempt: <reason> file comment)
  // - no-direct-session: every protected route must use the centralized
  //   helpers in @/lib/api-auth (withAuth / withAdmin / requireAdmin) instead
  //   of calling getSession or auth.api.getSession directly
  //   (opt out with a // auth-direct: <reason> file comment)
  {
    files: ["src/app/api/**/route.ts"],
    rules: {
      "pinchy/require-audit-log": "error",
      "pinchy/no-direct-session": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
