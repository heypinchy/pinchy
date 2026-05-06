/**
 * Reject direct `getSession` / `auth.api.getSession` usage inside API
 * `route.ts` files. Every protected route should go through the centralized
 * helpers in `@/lib/api-auth` (`withAuth`, `withAdmin`, or `requireAdmin`) so
 * the auth shape, error bodies, and future cross-cutting concerns (rate
 * limits, structured logging, audit hooks) live in one place.
 *
 * Opt-out: add a file-level comment `// auth-direct: <reason>` for the rare
 * case where the wrappers don't fit (browser-flow endpoints that must render
 * auth failure as a redirect, not JSON — e.g. OAuth callbacks).
 *
 * @type {import('eslint').Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid direct getSession / auth.api.getSession in API route handlers — use withAuth / withAdmin / requireAdmin from @/lib/api-auth.",
    },
    messages: {
      directGetSession:
        "Do not call getSession or auth.api.getSession directly in API route handlers. Use withAuth(), withAdmin(), or requireAdmin() from @/lib/api-auth. If this route legitimately needs the inline pattern (e.g. redirect on auth failure), add a file-level comment: // auth-direct: <reason>",
      missingDirectReason: "auth-direct comment must include a reason: // auth-direct: <reason>",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!filename.includes("/app/api/") || !filename.endsWith("route.ts")) {
      return {};
    }

    const sourceCode = context.sourceCode || context.getSourceCode();
    const comments = sourceCode.getAllComments();
    const exemptComment = comments.find((c) => c.value.trim().startsWith("auth-direct"));

    if (exemptComment) {
      const text = exemptComment.value.trim();
      if (!text.match(/^auth-direct:\s*\S/)) {
        context.report({
          node: exemptComment,
          messageId: "missingDirectReason",
        });
      }
      // File opted out — skip the rest.
      return {};
    }

    return {
      // Catch: import { getSession } from "@/lib/auth"
      ImportDeclaration(node) {
        if (node.source.value !== "@/lib/auth") return;
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported &&
            spec.imported.name === "getSession"
          ) {
            context.report({ node: spec, messageId: "directGetSession" });
          }
        }
      },
      // Catch: auth.api.getSession(...)
      MemberExpression(node) {
        if (
          node.property &&
          node.property.type === "Identifier" &&
          node.property.name === "getSession" &&
          node.object &&
          node.object.type === "MemberExpression" &&
          node.object.property &&
          node.object.property.type === "Identifier" &&
          node.object.property.name === "api" &&
          node.object.object &&
          node.object.object.type === "Identifier" &&
          node.object.object.name === "auth"
        ) {
          context.report({ node, messageId: "directGetSession" });
        }
      },
    };
  },
};
