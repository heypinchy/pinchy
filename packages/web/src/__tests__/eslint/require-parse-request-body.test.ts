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
  ],
});
