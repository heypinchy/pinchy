import { RuleTester } from "eslint";
import rule from "../../../eslint-rules/require-audit-log.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("require-audit-log", rule, {
  valid: [
    {
      code: `export async function POST(req) { appendAuditLog({ eventType: "test" }); }`,
      filename: "/app/api/groups/route.ts",
    },
    {
      code: `// audit-exempt: read-only endpoint\nexport async function POST(req) { return "ok"; }`,
      filename: "/app/api/health/route.ts",
    },
    {
      code: `export async function POST(req) { return "ok"; }`,
      filename: "/lib/helpers.ts",
    },
    {
      code: `export async function GET(req) { return "ok"; }`,
      filename: "/app/api/data/route.ts",
    },
    {
      code: `export const POST = async (req) => { appendAuditLog({ eventType: "test" }); }`,
      filename: "/app/api/groups/route.ts",
    },
    {
      code: `export async function POST(req) { await appendAuditLog({ eventType: "test" }); }`,
      filename: "/app/api/groups/route.ts",
    },
    {
      code: `export async function POST(req) { deferAuditLog({ eventType: "test" }); }`,
      filename: "/app/api/groups/route.ts",
    },
  ],
  invalid: [
    {
      code: `export async function POST(req) { return "ok"; }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    {
      code: `export async function DELETE(req) { return "ok"; }`,
      filename: "/app/api/groups/[id]/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    {
      code: `// audit-exempt\nexport async function POST(req) { return "ok"; }`,
      filename: "/app/api/test/route.ts",
      errors: [{ messageId: "missingExemptReason" }],
    },
    {
      code: `export const DELETE = async (req) => { return "ok"; }`,
      filename: "/app/api/groups/[id]/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    {
      code: `export async function PUT(req) { return "ok"; }`,
      filename: "/app/api/settings/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    {
      code: `export async function PATCH(req) { return "ok"; }`,
      filename: "/app/api/users/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    {
      code: `export async function POST(req) { appendAuditLog({ eventType: "test" }).catch(console.error); }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "noFireAndForgetAudit" }],
    },
    {
      code: `export async function DELETE(req) { appendAuditLog({ eventType: "test" }).catch(() => {}); }`,
      filename: "/app/api/groups/[id]/route.ts",
      errors: [{ messageId: "noFireAndForgetAudit" }],
    },
    {
      code: `export const PATCH = async (req) => { appendAuditLog({ eventType: "test" }).catch(console.error); }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "noFireAndForgetAudit" }],
    },
  ],
});
