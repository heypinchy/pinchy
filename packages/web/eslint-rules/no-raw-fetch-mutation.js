// ESLint rule: forbid raw `fetch(url, { method: "POST" | "PUT" | "PATCH" |
// "DELETE" })` in client components, hooks and client pages. Mutating calls go
// through the typed helpers in `@/lib/api-client` (`apiPost`, `apiPut`,
// `apiPatch`, `apiDelete`).
//
// Why: AGENTS.md § "Shared Schemas And Typed Client" promises that a drift
// between the client's payload and the route's Zod schema is a compile-time
// error rather than a runtime 400 — a promise a raw `fetch` cannot keep,
// because `JSON.stringify(anything)` type-checks. The 2026-08-04 repo review
// (#1075) counted 43 mutating raw fetches across 19 files against 23 files
// that had adopted the helper, three of which used both side by side. (The
// issue's own estimate was 37; the count above is the verified one.)
//
// The cost is not only the missing type. `send()` in api-client.ts reads the
// route's error contract (`{ error, message, details }`) and raises an
// `ApiError` carrying the server's own wording; a hand-rolled `if (!res.ok)`
// almost always throws that wording away. `settings-users.tsx` showed a
// generic "Something went wrong" toast while the route was answering
// "Invite not found" — the user could not tell a stale list from an outage.
//
// Scope: `src/components/**`, `src/hooks/**` and `src/app/**/*.tsx`. Server
// code is deliberately out — `src/lib/**`, `src/server/**` and the route
// handlers under `src/app/api/**/route.ts` reach real third-party endpoints
// where there is no api-client to reach for. Note that this is a path scope,
// not a "runs in the browser" scope: a Server Component under src/app that
// calls a third-party API needs the exemption comment, and its reason is a
// true statement rather than a dodge.
//
// Two limits, stated plainly rather than papered over:
//
//   - The rule reads a STRING LITERAL method. `fetch(url, { method: verb })`
//     is not reported, because reporting it would mean guessing: the rule
//     cannot see whether `verb` is "GET". No call site in the tree does this
//     today. Writing the indirection to dodge the rule is a deliberate act,
//     and review owns that case — the same limit no-untracked-sleeps states
//     about the `setTimeout` spelling of a sleep.
//   - It says nothing about GET. `apiGet` exists and is preferable, but a GET
//     that streams, reads headers, or is aborted via a signal is legitimate,
//     and this rule is about the error-contract drift that only mutations
//     produce.
//
// The exemption is `// raw-fetch-exempt: <reason>` in the comment block
// directly above the call's own statement, with no code in between — narrow
// like no-untracked-sleeps rather than file-wide like `// audit-exempt:`,
// because a file-wide marker is exactly the blind spot #1060 closed in
// require-audit-log: one legitimate raw fetch would silently clear every other
// one in the same file.
//
// It takes a written REASON, not an issue number, and that difference from the
// skip policy is deliberate: a skip DEFERS work and so needs somewhere for the
// work to live, while "this call cannot use the helper" ASSERTS a fact —
// a multipart upload, a streamed response, a call that needs the raw
// `Response`. The useful artefact is the assertion itself, sitting next to the
// call it describes. Same reasoning as the `Docs-not-needed:` trailer.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const HELPER_FOR_METHOD = {
  POST: "apiPost",
  PUT: "apiPut",
  PATCH: "apiPatch",
  DELETE: "apiDelete",
};

// `// raw-fetch-exempt:` followed by at least one word character — a bare
// marker asserts nothing and is not an exemption.
const EXEMPTION_RE = /raw-fetch-exempt:\s*\S/;

/**
 * Client-side surfaces only. Route handlers live under src/app too but are
 * server code, so `.tsx` is what separates a page from a handler there.
 */
function isInScope(filename) {
  const path = filename.replace(/\\/g, "/");
  if (path.includes("/src/__tests__/")) return false;
  if (path.includes("/src/components/") || path.includes("/src/hooks/")) {
    return /\.(ts|tsx)$/.test(path);
  }
  if (path.includes("/src/app/")) return path.endsWith(".tsx");
  return false;
}

/** Unwrap `"POST" as const` / `"POST" satisfies string` down to the literal. */
function unwrapTypeAssertions(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion")
  ) {
    current = current.expression;
  }
  return current;
}

/** The method as written, or null when it is not a plain string. */
function staticMethodValue(node) {
  const value = unwrapTypeAssertions(node);
  if (!value) return null;
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  if (value.type === "TemplateLiteral" && value.expressions.length === 0) {
    return value.quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return null;
}

function isFetchCallee(callee) {
  if (callee.type === "Identifier") return callee.name === "fetch";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "fetch" &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "window" || callee.object.name === "globalThis")
  );
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid raw mutating fetch() in client components, hooks and pages — use the typed helpers in @/lib/api-client",
    },
    messages: {
      rawFetchMutation:
        'Do not call `fetch(url, { method: "{{method}}" })` here. Use `{{helper}}` from `@/lib/api-client`: it types the request body against the route\'s shared schema (so payload drift is a compile error, not a runtime 400) and raises an `ApiError` carrying the server\'s own message instead of a generic toast. If this call genuinely cannot use the helper — a multipart upload, a streamed response, a raw `Response` you need — put `// raw-fetch-exempt: <reason>` directly above the statement. See AGENTS.md § "Shared Schemas And Typed Client".',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isInScope(filename)) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();

    /**
     * The comments attached directly above the call's own statement — i.e.
     * everything between the previous token and this one. Any code in between
     * ends the block, which is what keeps one legitimate raw fetch from
     * clearing every other one in the file.
     */
    function hasExemption(node) {
      let statement = node;
      while (statement.parent && !/Statement|Declaration/.test(statement.type)) {
        statement = statement.parent;
      }
      return sourceCode
        .getCommentsBefore(statement)
        .some((comment) => EXEMPTION_RE.test(comment.value));
    }

    return {
      CallExpression(node) {
        if (!isFetchCallee(node.callee)) return;

        const init = node.arguments[1];
        if (!init || init.type !== "ObjectExpression") return;

        for (const property of init.properties) {
          if (property.type !== "Property" || property.computed) continue;
          const key =
            property.key.type === "Identifier"
              ? property.key.name
              : property.key.type === "Literal"
                ? property.key.value
                : null;
          if (key !== "method") continue;

          const method = staticMethodValue(property.value);
          if (method === null) return;
          if (!MUTATING_METHODS.has(method.toUpperCase())) return;
          if (hasExemption(node)) return;

          context.report({
            node,
            messageId: "rawFetchMutation",
            data: { method, helper: HELPER_FOR_METHOD[method.toUpperCase()] },
          });
          return;
        }
      },
    };
  },
};
