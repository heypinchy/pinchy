/**
 * Forbid reading the incoming request body directly in API route handlers —
 * every state-mutating route must go through `parseRequestBody()` from
 * `@/lib/api-validation`. Catches regressions where a new route would skip Zod
 * validation, return 500 on malformed JSON, or drift away from the shared error
 * contract.
 *
 * "The incoming request" is whatever the route handler's first parameter binds,
 * whatever it is called, plus the historical `request` / `req` names for the
 * cases scope cannot resolve. It is deliberately NOT "the first parameter of
 * the nearest enclosing function": reading an upstream `Response` inside a
 * route — `fetch(url).then((res) => res.json())` — is ordinary work, and a rule
 * that reports it would be telling the author to run a Zod schema over someone
 * else's reply.
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

    const sourceCode = context.sourceCode || context.getSourceCode();

    // The names a Next.js request has carried here since the rule was written.
    // Matching on the name alone is crude, but it is the half of the check that
    // needs no resolution at all, so it still fires when the request reaches
    // the call as a free variable — a handler that destructures its first
    // parameter, a helper that takes the request as an argument.
    const FALLBACK_NAMES = new Set(["request", "req"]);

    const HANDLER_EXPORT_NAMES = new Set([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]);

    function isFunctionNode(node) {
      return (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      );
    }

    function addFirstParam(fn, params) {
      const first = fn.params[0];
      if (first && first.type === "Identifier") params.add(first);
    }

    // `export const POST = withAdmin(async (request, ctx, session) => …)` — the
    // request is the first parameter of the callback a wrapper receives, however
    // many wrappers deep it sits.
    function collectFromInitializer(init, params, depth) {
      if (!init || depth > 4) return;
      if (isFunctionNode(init)) {
        addFirstParam(init, params);
        return;
      }
      if (init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression") {
        collectFromInitializer(init.expression, params, depth + 1);
        return;
      }
      if (init.type === "CallExpression") {
        for (const arg of init.arguments) collectFromInitializer(arg, params, depth + 1);
      }
    }

    // The parameter bindings that ARE the incoming request: the first parameter
    // of every exported route handler in this file. Anything else — a callback
    // in a `.map()`, a local helper, an upstream `Response` — is not.
    let handlerRequestParams = null;
    function getHandlerRequestParams() {
      if (handlerRequestParams) return handlerRequestParams;
      handlerRequestParams = new Set();
      for (const stmt of sourceCode.ast.body) {
        if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) continue;
        const decl = stmt.declaration;
        if (
          decl.type === "FunctionDeclaration" &&
          decl.id &&
          HANDLER_EXPORT_NAMES.has(decl.id.name)
        ) {
          addFirstParam(decl, handlerRequestParams);
          continue;
        }
        if (decl.type === "VariableDeclaration") {
          for (const declarator of decl.declarations) {
            if (declarator.id.type === "Identifier" && HANDLER_EXPORT_NAMES.has(declarator.id.name))
              collectFromInitializer(declarator.init, handlerRequestParams, 0);
          }
        }
      }
      return handlerRequestParams;
    }

    function resolveVariable(identifier) {
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return null;
    }

    // Resolution runs through scope, not through the call's position in the
    // tree: a handler's request stays the request inside a `.map()` callback
    // that has parameters of its own, and that callback's parameter never
    // becomes the request just by being the nearest one.
    function isHandlerRequest(identifier) {
      const requestParams = getHandlerRequestParams();
      if (requestParams.size === 0) return false;
      const variable = resolveVariable(identifier);
      if (!variable) return false;
      return variable.defs.some((def) => def.type === "Parameter" && requestParams.has(def.name));
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
          (FALLBACK_NAMES.has(node.callee.object.name) || isHandlerRequest(node.callee.object))
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
