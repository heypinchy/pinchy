/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require appendAuditLog() / deferAuditLog() in API route mutation handlers (POST/PUT/PATCH/DELETE) and forbid fire-and-forget .catch() on appendAuditLog",
    },
    messages: {
      missingAuditLog:
        "Mutation handler '{{method}}' must call appendAuditLog() or deferAuditLog(). If this endpoint doesn't need auditing, add a file-level comment: // audit-exempt: <reason>",
      missingExemptReason: "audit-exempt comment must include a reason: // audit-exempt: <reason>",
      noFireAndForgetAudit:
        "Do not chain .catch() onto appendAuditLog(): silently swallowed audit failures break the audit-trail contract (see #231). Either `await appendAuditLog(...)` (fail-closed, returns 500) or wrap with `deferAuditLog(...)` from @/lib/audit-deferred (deferred + structured failure signal).",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const isRouteFile = filename.includes("/app/api/") && filename.endsWith("route.ts");

    // The .catch() ban applies to every file, not just route handlers — the
    // pattern is wrong everywhere it appears, and the fix is the same.
    const fireAndForgetVisitors = {
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "catch" &&
          node.callee.object.type === "CallExpression" &&
          node.callee.object.callee.type === "Identifier" &&
          node.callee.object.callee.name === "appendAuditLog"
        ) {
          context.report({
            node,
            messageId: "noFireAndForgetAudit",
          });
        }
      },
    };

    if (!isRouteFile) {
      return fireAndForgetVisitors;
    }

    const sourceCode = context.sourceCode || context.getSourceCode();
    const comments = sourceCode.getAllComments();
    const exemptComment = comments.find((c) => c.value.trim().startsWith("audit-exempt"));

    if (exemptComment) {
      const text = exemptComment.value.trim();
      if (!text.match(/^audit-exempt:\s*\S/)) {
        context.report({
          node: exemptComment,
          messageId: "missingExemptReason",
        });
      }
      return fireAndForgetVisitors;
    }

    const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

    return {
      ...fireAndForgetVisitors,
      ExportNamedDeclaration(node) {
        const decl = node.declaration;
        if (!decl) return;

        if (decl.type === "FunctionDeclaration" && decl.id) {
          const name = decl.id.name;
          if (!MUTATION_METHODS.includes(name)) return;
          checkFunctionBody(context, decl.body, name);
        }

        if (decl.type === "VariableDeclaration") {
          for (const declarator of decl.declarations) {
            if (
              declarator.id.type === "Identifier" &&
              MUTATION_METHODS.includes(declarator.id.name)
            ) {
              checkInitializer(context, declarator.init, declarator.id.name);
            }
          }
        }
      },
    };

    function bodyMentionsAudit(text) {
      return text.includes("appendAuditLog") || text.includes("deferAuditLog");
    }

    function checkFunctionBody(ctx, body, methodName) {
      if (!body) return;
      const source = ctx.sourceCode || ctx.getSourceCode();
      const text = source.getText(body);
      if (!bodyMentionsAudit(text)) {
        ctx.report({
          node: body,
          messageId: "missingAuditLog",
          data: { method: methodName },
        });
      }
    }

    function checkInitializer(ctx, init, methodName) {
      if (!init) return;
      const source = ctx.sourceCode || ctx.getSourceCode();
      const text = source.getText(init);
      if (!bodyMentionsAudit(text)) {
        ctx.report({
          node: init,
          messageId: "missingAuditLog",
          data: { method: methodName },
        });
      }
    }
  },
};
