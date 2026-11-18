import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-raw-fetch-mutation.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const CLIENT = "/repo/packages/web/src/components/settings-users.tsx";

tester.run("no-raw-fetch-mutation", rule, {
  valid: [
    // The typed client is the point of the rule — never reported.
    {
      code: `await apiPost("/api/users/invite", { email });`,
      filename: CLIENT,
    },
    // A read is not a mutation. GET/HEAD stay on raw fetch (apiGet exists, but
    // a GET that reads headers or streams is legitimate and this rule is about
    // the error-contract drift that only mutations produce).
    {
      code: `await fetch("/api/agents");`,
      filename: CLIENT,
    },
    {
      code: `await fetch(url, { method: "GET" });`,
      filename: CLIENT,
    },
    {
      code: `await fetch(url, { method: "HEAD", signal: ctrl.signal });`,
      filename: CLIENT,
    },
    // Outside the configured scope the rule does nothing — server code, tests
    // and plugins reach real third-party endpoints where there is no api-client.
    {
      code: `await fetch("https://api.example.com", { method: "POST" });`,
      filename: "/repo/packages/web/src/lib/some-server-lib.ts",
    },
    {
      code: `await fetch("/api/x", { method: "POST" });`,
      filename: "/repo/packages/web/src/__tests__/api/x.test.ts",
    },
    // An exemption with a written reason on the statement directly above.
    {
      code: `// raw-fetch-exempt: multipart upload — apiPost JSON-stringifies the body\nawait fetch("/api/upload", { method: "POST", body: form });`,
      filename: CLIENT,
    },
    // Block comments carry the exemption too.
    {
      code: `/* raw-fetch-exempt: needs the raw Response to stream the download */\nconst res = await fetch("/api/export", { method: "POST" });`,
      filename: CLIENT,
    },
    // The exemption clears only the statement it sits on, but it does clear a
    // multi-line call.
    {
      code: `// raw-fetch-exempt: reads Content-Disposition off the response\nconst res = await fetch("/api/export", {\n  method: "POST",\n  body: JSON.stringify(x),\n});`,
      filename: CLIENT,
    },
    // A non-literal method is out of the rule's reach by design (see the header
    // comment) — it must not be reported, or the rule guesses.
    {
      code: `await fetch(url, { method: verb });`,
      filename: CLIENT,
    },
    // `fetch` as a value, not a call.
    {
      code: `const f = fetch;`,
      filename: CLIENT,
    },
    // A same-named method on something that is not fetch.
    {
      code: `await client.request(url, { method: "POST" });`,
      filename: CLIENT,
    },
    // No init object at all.
    {
      code: `await fetch(url);`,
      filename: CLIENT,
    },
    // API route handlers live under src/app too, and are server code — the
    // rule must not reach them (`.ts`, not `.tsx`).
    {
      code: `await fetch("https://third-party.example", { method: "POST" });`,
      filename: "/repo/packages/web/src/app/api/x/route.ts",
    },
  ],
  invalid: [
    {
      code: `await fetch("/api/users/invite", { method: "POST", body: JSON.stringify(b) });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation", data: { method: "POST", helper: "apiPost" } }],
    },
    {
      code: `await fetch(\`/api/users/\${id}\`, { method: "DELETE" });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation", data: { method: "DELETE", helper: "apiDelete" } }],
    },
    {
      code: `await fetch(url, { method: "PATCH", body: b });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation", data: { method: "PATCH", helper: "apiPatch" } }],
    },
    {
      code: `await fetch(url, { method: "PUT", body: b });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation", data: { method: "PUT", helper: "apiPut" } }],
    },
    // Lowercase and mixed case are the same request.
    {
      code: `await fetch(url, { method: "post" });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation", data: { method: "post", helper: "apiPost" } }],
    },
    // A template literal with no expressions is a string literal.
    {
      code: "await fetch(url, { method: `POST` });",
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation" }],
    },
    // TypeScript wrappers must not hide the method.
    {
      code: `await fetch(url, { method: "POST" as const });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation" }],
      languageOptions: { parser: tsParser },
    },
    // window.fetch / globalThis.fetch are the same call.
    {
      code: `await window.fetch(url, { method: "POST" });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation" }],
    },
    {
      code: `await globalThis.fetch(url, { method: "DELETE" });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation" }],
    },
    // Hooks are in scope.
    {
      code: `await fetch("/api/integrations/x", { method: "POST" });`,
      filename: "/repo/packages/web/src/hooks/use-integration-actions.ts",
      errors: [{ messageId: "rawFetchMutation" }],
    },
    // Client pages under app/ are in scope; API route handlers (.ts) are not.
    {
      code: `await fetch("/api/invite/claim", { method: "POST" });`,
      filename: "/repo/packages/web/src/app/invite/[token]/page.tsx",
      errors: [{ messageId: "rawFetchMutation" }],
    },
    // A bare marker with no reason is not an exemption — same contract as the
    // Docs-not-needed trailer: the assertion IS the artefact.
    {
      code: `// raw-fetch-exempt:\nawait fetch(url, { method: "POST" });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation" }],
    },
    // A comment that does not carry the marker is not an exemption.
    {
      code: `// this one is fine, promise\nawait fetch(url, { method: "POST" });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation" }],
    },
    // An exemption further up, with code in between, does not reach down.
    {
      code: `// raw-fetch-exempt: applies to the call above only\nawait fetch(a, { method: "POST" });\nawait fetch(b, { method: "POST" });`,
      filename: CLIENT,
      errors: [{ messageId: "rawFetchMutation" }],
    },
  ],
});
