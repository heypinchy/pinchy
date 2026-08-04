/**
 * Forbid `request.json()` / `req.json()` in API route handlers — every state-mutating
 * route must go through `parseRequestBody()` from `@/lib/api-validation`. Catches
 * regressions where a new route would skip Zod validation, return 500 on malformed
 * JSON, or drift away from the shared error contract.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid request.json() in API route handlers — use parseRequestBody() from @/lib/api-validation instead",
    },
    messages: {
      directJsonCall:
        "Do not call `{{callee}}.json()` directly in API routes. Define a Zod schema and use `parseRequestBody(schema, {{callee}})` from @/lib/api-validation. This guarantees a structured 400 on shape mismatch and on malformed JSON (instead of 500), and keeps the error contract consistent across routes.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!filename.includes("/app/api/") || !filename.endsWith("route.ts")) {
      return {};
    }

    // Historically-known names, used as a conservative fallback whenever the
    // first parameter's actual name can't be resolved (no enclosing function
    // has params, or the nearest one that does destructures its first
    // parameter instead of naming it plainly). Better a false positive here
    // than silently skipping the check.
    const FALLBACK_NAMES = new Set(["request", "req"]);

    function isFunctionNode(node) {
      return (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      );
    }

    // Resolve the identifier that names "the request" for a given `.json()`
    // call: walk up to the nearest enclosing function that actually declares a
    // first parameter (skipping functions with none — a nested closure with no
    // params of its own inherits the name from its enclosing handler via
    // closure). A plain Identifier first parameter names it exactly; anything
    // else (destructuring, defaults, ...) can't be resolved, so fall back to
    // the historically-known names rather than skipping the call entirely.
    function resolveExpectedNames(node) {
      let current = node.parent;
      while (current) {
        if (isFunctionNode(current) && current.params.length > 0) {
          const first = current.params[0];
          if (first.type === "Identifier") {
            return new Set([first.name]);
          }
          return FALLBACK_NAMES;
        }
        current = current.parent;
      }
      return FALLBACK_NAMES;
    }

    return {
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "json" &&
          node.callee.object.type === "Identifier" &&
          node.arguments.length === 0 &&
          resolveExpectedNames(node).has(node.callee.object.name)
        ) {
          context.report({
            node,
            messageId: "directJsonCall",
            data: { callee: node.callee.object.name },
          });
        }
      },
    };
  },
};
