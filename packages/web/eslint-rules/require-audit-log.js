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
        "Mutation handler '{{method}}' must call appendAuditLog() or deferAuditLog(). If this endpoint doesn't need auditing, add a comment directly above it: // audit-exempt: <reason> (or above the file's imports to exempt every handler in the file).",
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
    const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

    // A marker is a comment that OPENS with "audit-exempt", followed
    // immediately by a colon, whitespace, or the end of the comment. The
    // anchoring is what has always kept prose that merely mentions the phrase
    // from counting; the boundary is what stops a different word sharing the
    // prefix (e.g. "audit-exemptions:") from being misread as one.
    const EXEMPT_ATTEMPT = /^audit-exempt(?::|\s|$)/;
    const EXEMPT_WITH_REASON = /^audit-exempt:\s*\S/;

    // A comment trailing another statement belongs to that statement, not to
    // whatever follows it: `const X = 1; // audit-exempt: …` reads as the
    // const's note, and getCommentsBefore would otherwise hand it to the next
    // handler as if it had been written above it.
    function isOwnLineComment(comment) {
      const before = sourceCode.getTokenBefore(comment, { includeComments: true });
      return !before || before.loc.end.line < comment.loc.start.line;
    }

    function findExemptAttempt(comments) {
      return (
        comments.find((c) => EXEMPT_ATTEMPT.test(c.value.trim()) && isOwnLineComment(c)) ?? null
      );
    }

    // Validates format and reports missingExemptReason if malformed. Caches by
    // comment identity so a comment consulted more than once — one
    // `export const POST = …, DELETE = …` statement is visited per declarator,
    // and each visit re-reads the same leading comment — is only ever reported
    // once.
    const exemptValidationCache = new Map();
    function validateExempt(comment) {
      if (exemptValidationCache.has(comment)) {
        return exemptValidationCache.get(comment);
      }
      const valid = EXEMPT_WITH_REASON.test(comment.value.trim());
      if (!valid) {
        context.report({ node: comment, messageId: "missingExemptReason" });
      }
      exemptValidationCache.set(comment, valid);
      return valid;
    }

    // A single marker in the file's header — above its first import — covers
    // every handler in the file. This is the only place one comment can exempt
    // more than the handler it's directly attached to.
    //
    // A file with no imports has no header to sit in: "before the first
    // statement" is just that statement's own leading comment, and reading it
    // as file-wide would leave the dead switch this rule closed — a marker
    // above an unrelated `const` silently waiving the handler below it.
    function findFileWideExemptComment(program) {
      const firstImport = program.body.find((n) => n.type === "ImportDeclaration");
      if (!firstImport) return null;
      return findExemptAttempt(sourceCode.getCommentsBefore(firstImport));
    }

    let hasFileWideExemptAttempt = false;

    // True when this handler's own audit requirement was waived — either by a
    // comment directly above its export (nothing else in between) or by the
    // file-wide marker. Also true when an attempt was made but is malformed:
    // validateExempt has already reported that, and piling on a second,
    // unrelated "missing audit log" error would only be confusing.
    function isExemptAttempted(exportNode) {
      const handlerExempt = findExemptAttempt(sourceCode.getCommentsBefore(exportNode));
      if (handlerExempt) {
        validateExempt(handlerExempt);
        return true;
      }
      return hasFileWideExemptAttempt;
    }

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

    return {
      ...fireAndForgetVisitors,
      Program(programNode) {
        const exempt = findFileWideExemptComment(programNode);
        if (exempt) {
          hasFileWideExemptAttempt = true;
          validateExempt(exempt);
        }
      },
      ExportNamedDeclaration(node) {
        const decl = node.declaration;
        if (!decl) return;

        if (decl.type === "FunctionDeclaration" && decl.id) {
          const name = decl.id.name;
          if (!MUTATION_METHODS.includes(name)) return;
          if (isExemptAttempted(node)) return;
          checkFunctionBody(context, decl.body, name);
        }

        if (decl.type === "VariableDeclaration") {
          for (const declarator of decl.declarations) {
            if (
              declarator.id.type === "Identifier" &&
              MUTATION_METHODS.includes(declarator.id.name)
            ) {
              if (isExemptAttempted(node)) continue;
              checkInitializer(context, declarator.init, declarator.id.name);
            }
          }
        }
      },
    };
  },
};
