/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require appendAuditLog() in API route mutation handlers (POST/PUT/PATCH/DELETE)",
    },
    messages: {
      missingAuditLog:
        "Mutation handler '{{method}}' must call appendAuditLog(). If this endpoint doesn't need auditing, add a file-level comment: // audit-exempt: <reason>",
      missingExemptReason: "audit-exempt comment must include a reason: // audit-exempt: <reason>",
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
    const exemptComment = comments.find((c) => c.value.trim().startsWith("audit-exempt"));

    if (exemptComment) {
      const text = exemptComment.value.trim();
      if (!text.match(/^audit-exempt:\s*\S/)) {
        context.report({
          node: exemptComment,
          messageId: "missingExemptReason",
        });
      }
      return {};
    }

    const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

    return {
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

    function checkFunctionBody(ctx, body, methodName) {
      if (!body) return;
      const source = ctx.sourceCode || ctx.getSourceCode();
      const text = source.getText(body);
      if (!text.includes("appendAuditLog")) {
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
      if (!text.includes("appendAuditLog")) {
        ctx.report({
          node: init,
          messageId: "missingAuditLog",
          data: { method: methodName },
        });
      }
    }
  },
};
