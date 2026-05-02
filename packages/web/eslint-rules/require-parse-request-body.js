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

    return {
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "json" &&
          node.callee.object.type === "Identifier" &&
          (node.callee.object.name === "request" || node.callee.object.name === "req") &&
          node.arguments.length === 0
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
