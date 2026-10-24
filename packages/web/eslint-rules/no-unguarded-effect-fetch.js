// ESLint rule: a load started from a `useEffect` must catch its own failure.
//
// Reports an `await fetch(...)` / `await apiGet(...)` (and the other api-client
// helpers) inside a function that runs from a `useEffect` / `useLayoutEffect`
// body, unless a `try` with a `catch` in that same function encloses it.
//
// Why: nothing awaits the promise an effect starts. A rejection therefore has
// nowhere to land, and the two places it surfaces are both bad:
//
//   - In the browser it is a silent dead end. The list stays empty, which is
//     indistinguishable from a genuinely empty result. On the audit table that
//     read as "nothing was logged"; on the agent permission sections it read as
//     "this agent has no access", and a save from that state replaced the real
//     grants.
//   - In a test run it is a suite-level unhandled rejection that ends
//     `pnpm test` with `Errors 1 error` and exit 1 while every test passes —
//     and only when the effect fires after that test's fetch mock was restored,
//     so it reproduces in a full run and not in isolation.
//
// #1212 fixed four of these by hand in new-agent-form.tsx and left three;
// #1216 fixed those and added this rule, because nothing would have stopped
// the eighth.
//
// What it asks for is a `catch`, not a particular body. The shape the codebase
// uses is in new-agent-form.tsx and audit-log-table.tsx: an AbortController the
// cleanup aborts, `apiGet(url, { signal })`, and a catch that stays silent when
// `signal.aborted` and toasts otherwise.
//
// A `try` only counts when it sits in the SAME function as the await. A
// try/catch around the definition of an inner async function does not catch
// what that function rejects with later, and a catch block or finally block is
// not guarded by its own try.
//
// Limits, stated so nobody reads the green check as more than it is:
//
//   - It follows functions DEFINED inside the effect. An async function made
//     with `useCallback` (or at module level) and merely CALLED from the effect
//     is not followed: the rule cannot see that the call is fire-and-forget,
//     and an event handler awaiting the same function is entitled to catch it
//     at the call site.
//   - It reads `await`. A `fetch(url).then(...)` chain with no `.catch` is the
//     same bug and is not reported.
//   - It checks that a catch exists, never what the catch does. An empty
//     `catch {}` passes. Review owns that case.
//
// The exemption is `// unguarded-load-exempt: <reason>` in the comment block
// directly above the awaited statement, with no code in between — per
// statement, like no-raw-fetch-mutation, because a file-wide marker would let
// one legitimate case clear every other one in the file. It takes a written
// REASON, not an issue number: "this load cannot fail in a way the user needs
// to hear about" asserts a fact rather than deferring work.

const LOAD_HELPERS = new Set(["fetch", "apiGet", "apiPost", "apiPut", "apiPatch", "apiDelete"]);
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect"]);

// A bare marker asserts nothing and is not an exemption.
const EXEMPTION_RE = /unguarded-load-exempt:\s*\S/;

/** Same scope as no-raw-fetch-mutation: client components, hooks and pages. */
function isInScope(filename) {
  const path = filename.replace(/\\/g, "/");
  if (path.includes("/src/__tests__/")) return false;
  if (path.includes("/src/components/") || path.includes("/src/hooks/")) {
    return /\.(ts|tsx)$/.test(path);
  }
  if (path.includes("/src/app/")) return path.endsWith(".tsx");
  return false;
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "TSInstantiationExpression" ||
      current.type === "ChainExpression")
  ) {
    current = current.expression;
  }
  return current;
}

/** The load's name as written ("fetch", "window.fetch", "apiGet"), or null. */
function loadCalleeName(argument) {
  const call = unwrap(argument);
  if (!call || call.type !== "CallExpression") return null;
  const callee = unwrap(call.callee);
  if (callee.type === "Identifier") {
    return LOAD_HELPERS.has(callee.name) ? callee.name : null;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "fetch" &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "window" || callee.object.name === "globalThis")
  ) {
    return `${callee.object.name}.fetch`;
  }
  return null;
}

function isFunction(node) {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/** Is `fn` the callback passed to useEffect / useLayoutEffect / React.useEffect? */
function isEffectCallback(fn) {
  const call = fn.parent;
  if (!call || call.type !== "CallExpression" || call.arguments[0] !== fn) return false;
  const callee = unwrap(call.callee);
  if (callee.type === "Identifier") return EFFECT_HOOKS.has(callee.name);
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    EFFECT_HOOKS.has(callee.property.name)
  );
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a catch around a load started from a useEffect, so its failure reaches the user instead of vanishing",
    },
    messages: {
      unguardedEffectFetch:
        "This `await {{callee}}(...)` runs from a useEffect with no `catch` around it. Nothing awaits the promise an effect starts, so a failure renders as an empty result and surfaces in tests as an unhandled rejection. Wrap it in try/catch: abort via an AbortController in the cleanup, stay silent when `signal.aborted`, and `toast.error(errorMessage(err, ...))` otherwise (see audit-log-table.tsx). If this load genuinely cannot fail in a way the user needs to hear about, put `// unguarded-load-exempt: <reason>` directly above the statement.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isInScope(filename)) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();

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
      AwaitExpression(node) {
        const callee = loadCalleeName(node.argument);
        if (!callee) return;

        let guarded = false;
        let crossedFunction = false;
        let child = node;
        for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
          if (
            !crossedFunction &&
            parent.type === "TryStatement" &&
            parent.handler &&
            parent.block === child
          ) {
            guarded = true;
          }
          if (isFunction(parent)) {
            if (isEffectCallback(parent)) {
              if (!guarded && !hasExemption(node)) {
                context.report({ node, messageId: "unguardedEffectFetch", data: { callee } });
              }
              return;
            }
            crossedFunction = true;
          }
        }
      },
    };
  },
};
