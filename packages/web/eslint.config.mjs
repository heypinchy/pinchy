import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";
import requireAuditLog from "./eslint-rules/require-audit-log.js";
import noDirectSession from "./eslint-rules/no-direct-session.js";

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
  // Pinchy custom rules for API route handlers:
  // - require-audit-log: every state-changing handler must call appendAuditLog
  //   (or set a // audit-exempt: <reason> file comment)
  // - no-direct-session: every protected route must use the centralized
  //   helpers in @/lib/api-auth (withAuth / withAdmin / requireAdmin) instead
  //   of calling getSession or auth.api.getSession directly
  //   (opt out with a // auth-direct: <reason> file comment)
  {
    files: ["src/app/api/**/route.ts"],
    plugins: {
      pinchy: {
        rules: {
          "require-audit-log": requireAuditLog,
          "no-direct-session": noDirectSession,
        },
      },
    },
    rules: {
      "pinchy/require-audit-log": "error",
      "pinchy/no-direct-session": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
