import { RuleTester } from "eslint";
import rule from "../../../eslint-rules/require-parse-request-body.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("require-parse-request-body", rule, {
  valid: [
    {
      code: `import { parseRequestBody } from "@/lib/api-validation";
        export async function POST(request) {
          const parsed = await parseRequestBody(schema, request);
          if ("error" in parsed) return parsed.error;
        }`,
      filename: "/app/api/groups/route.ts",
    },
    // Helper itself is allowed to call request.json()
    {
      code: `export async function parseRequestBody(schema, request) {
          const body = await request.json();
        }`,
      filename: "/lib/api-validation.ts",
    },
    // Outside /app/api/ paths the rule does not apply
    {
      code: `export async function handler(request) { const body = await request.json(); }`,
      filename: "/lib/some-other-file.ts",
    },
    // Calls on objects with other names (e.g. an external fetch response) are fine
    {
      code: `export async function POST() { const data = await response.json(); }`,
      filename: "/app/api/groups/route.ts",
    },
    // A destructured first parameter is unresolvable, but names other than the
    // conservative fallback ("request"/"req") still don't match.
    {
      code: `export async function POST({ headers }) { const data = await other.json(); }`,
      filename: "/app/api/groups/route.ts",
    },
  ],
  invalid: [
    {
      code: `export async function POST(request) { const body = await request.json(); }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    {
      code: `export async function PUT(req) { const { content } = await req.json(); }`,
      filename: "/app/api/users/me/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    {
      code: `export async function PATCH(request) {
          const { name } = await request.json();
        }`,
      filename: "/app/api/agents/[id]/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    // A renamed first parameter must still be caught — the rule resolves the
    // name from the enclosing handler's own signature rather than a fixed
    // whitelist of "request"/"req".
    {
      code: `export async function POST(_req) { const body = await _req.json(); }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    {
      code: `export async function POST(r) { const body = await r.json(); }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    {
      code: `export const PUT = async (nextRequest) => { const body = await nextRequest.json(); }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    // A nested closure with no first parameter of its own inherits the name
    // from the enclosing handler.
    {
      code: `export async function POST(_req) {
          return withRetry(async () => {
            const body = await _req.json();
          });
        }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    // A destructured first parameter can't be resolved to a name — conservative
    // fallback still flags the historically-known "request"/"req" names rather
    // than silently skipping the check.
    {
      code: `export async function POST({ headers }) { const body = await request.json(); }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
  ],
});
