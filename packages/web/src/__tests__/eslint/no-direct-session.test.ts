import { RuleTester } from "eslint";
import rule from "../../../eslint-rules/no-direct-session.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-direct-session", rule, {
  valid: [
    // Routes using the centralized helpers — fine.
    {
      code: `import { withAuth } from "@/lib/api-auth"; export const GET = withAuth(async () => {});`,
      filename: "/app/api/foo/route.ts",
    },
    {
      code: `import { withAdmin } from "@/lib/api-auth"; export const POST = withAdmin(async () => {});`,
      filename: "/app/api/foo/route.ts",
    },
    {
      code: `import { requireAdmin } from "@/lib/api-auth"; export async function GET() { await requireAdmin(); }`,
      filename: "/app/api/foo/route.ts",
    },
    // Non-route files may use getSession freely (e.g. lib/api-auth.ts itself,
    // server components, server-side actions).
    {
      code: `import { getSession } from "@/lib/auth"; export async function helper() { return getSession(); }`,
      filename: "/lib/api-auth.ts",
    },
    {
      code: `import { auth } from "@/lib/auth"; export async function helper() { return auth.api.getSession(); }`,
      filename: "/lib/some-helper.ts",
    },
    // A route file with a documented opt-out is allowed (e.g. OAuth callback
    // that needs a redirect on failure rather than the wrapper's JSON 401).
    {
      code: `// auth-direct: redirect on failure, wrappers return JSON\nimport { getSession } from "@/lib/auth"; export async function GET() { await getSession(); }`,
      filename: "/app/api/integrations/oauth/callback/route.ts",
    },
  ],
  invalid: [
    // Direct named import of getSession from @/lib/auth in a route.ts
    {
      code: `import { getSession } from "@/lib/auth"; export async function GET() { await getSession(); }`,
      filename: "/app/api/foo/route.ts",
      errors: [{ messageId: "directGetSession" }],
    },
    // auth.api.getSession member access in a route.ts
    {
      code: `import { auth } from "@/lib/auth"; export async function GET() { await auth.api.getSession(); }`,
      filename: "/app/api/foo/route.ts",
      errors: [{ messageId: "directGetSession" }],
    },
    // auth-direct comment without a reason is a stub — must explain why
    {
      code: `// auth-direct\nimport { getSession } from "@/lib/auth"; export async function GET() { await getSession(); }`,
      filename: "/app/api/foo/route.ts",
      errors: [{ messageId: "missingDirectReason" }],
    },
  ],
});
