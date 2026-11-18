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
    // Reading an UPSTREAM response inside a route is ordinary work, not a
    // skipped-validation bug. The callback parameter is a Response, and telling
    // the author to `parseRequestBody(schema, res)` would be nonsense advice.
    {
      code: `export async function POST(request) {
          const parsed = await parseRequestBody(schema, request);
          return fetch(url).then((res) => res.json());
        }`,
      filename: "/app/api/groups/route.ts",
    },
    {
      code: `export async function POST(request) {
          const parsed = await parseRequestBody(schema, request);
          return Promise.all(responses.map((r) => r.json()));
        }`,
      filename: "/app/api/groups/route.ts",
    },
    // A local helper in the same file is not a route handler, so its first
    // parameter is not "the request" — even when it is called `response`.
    {
      code: `async function readUpstream(response) {
          return response.json();
        }
        export async function POST(request) {
          const parsed = await parseRequestBody(schema, request);
          return readUpstream(await fetch(url));
        }`,
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
    // request from the ROUTE HANDLER's own signature rather than a fixed
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
    // The dominant shape in this codebase: the handler is a callback handed to
    // an auth wrapper, so the request is that callback's first parameter.
    {
      code: `export const POST = withAdmin(async (rq, _ctx, session) => { const body = await rq.json(); });`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    // A nested closure with no first parameter of its own still sees the
    // handler's request through the closure.
    {
      code: `export async function POST(_req) {
          return withRetry(async () => {
            const body = await _req.json();
          });
        }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    // ...and so does a nested closure that HAS parameters of its own. Resolving
    // only "the nearest enclosing function with parameters" loses this: the
    // callback's own parameter shadows nothing, and the real request.json()
    // slips through — the very call the rule exists to ban.
    {
      code: `export async function POST(_req) {
          return items.map((item) => _req.json());
        }`,
      filename: "/app/api/groups/route.ts",
      errors: [{ messageId: "directJsonCall" }],
    },
    {
      code: `export async function POST(req) {
          return upstream.then((res) => req.json());
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
