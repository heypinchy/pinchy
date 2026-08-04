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
    // A file-top exempt (before the first import) covers every handler in the file.
    {
      code: `// audit-exempt: nothing here mutates persisted state\nimport { NextResponse } from "next/server";\nexport async function POST(req) { return "ok"; }\nexport async function DELETE(req) { return "ok"; }`,
      filename: "/app/api/groups/route.ts",
    },
    // A per-handler exempt covers only the handler it's directly attached to,
    // and a sibling handler with a real audit call is independently fine.
    {
      code: `import { NextResponse } from "next/server";\n// audit-exempt: read-only forwarding, no persisted state change\nexport async function PUT(req) { return "ok"; }\nexport async function DELETE(req) { appendAuditLog({ eventType: "test" }); }`,
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
    // An exempt comment attached to GET must not exempt a mutation handler
    // elsewhere in the same file — the exemption is per-handler, not file-wide.
    {
      code: `import { NextResponse } from "next/server";\n// audit-exempt: read-only listing\nexport async function GET(req) { return "ok"; }\nexport async function POST(req) { return "ok"; }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    // A comment that merely MENTIONS "audit-exempt:" inside a sentence is not
    // a marker — only a comment that starts with it counts.
    {
      code: `import { NextResponse } from "next/server";\n// This route deliberately carries NO audit-exempt: marker, unlike its sibling.\nexport async function POST(req) { return "ok"; }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    // A different word sharing the "audit-exempt" prefix must not match.
    {
      code: `import { NextResponse } from "next/server";\n// audit-exemptions: this is a different marker entirely\nexport async function POST(req) { return "ok"; }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
    // An exempt comment separated from its handler by an intervening
    // declaration does not attach to that handler (it must sit directly above
    // the export, with nothing in between).
    {
      code: `import { NextResponse } from "next/server";\n// audit-exempt: dev-only endpoint\nconst SOME_CONST = 1;\nexport async function POST(req) { return "ok"; }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "missingAuditLog" }],
    },
  ],
});
