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
// "Runs from a useEffect" covers two shapes:
//
//   - A function DEFINED inside the effect body, at any depth.
//   - A function the effect CALLS and drops: a bare `fn();` or `void fn();`
//     statement anywhere in the effect body, where `fn` resolves (by scope,
//     not by name) to a `function fn() {}`, a `const fn = async () => {}` /
//     `function () {}`, or a `const fn = useCallback(async () => {}, deps)`
//     declared inside a function in this file — in practice, the component.
//     This is the settings-page shape: a `fetchData` made with useCallback so
//     the effect and the post-save refresh share it. Once one effect drops it,
//     its awaits need a catch of their own, even if an event handler elsewhere
//     awaits the same function inside a try. A call the effect hands somewhere
//     — `fn().catch(...)`, `await fn()` inside a try, `const p = fn()` — is
//     not dropped, and the function is not followed for it.
//
// Limits, stated so nobody reads the green check as more than it is:
//
//   - Following a called function goes one level deep and stays in the file.
//     A function declared at module level, imported from another file, or
//     called only by another followed function is not followed. Module level
//     is excluded on purpose: those are shared helpers whose callers decide
//     what a failure means, and no effect in the codebase drops one today.
//   - It reads `await`. It sees through an awaited `.then`/`.finally` chain and
//     `Promise.all/any/race([...])`, but a load that is never awaited
//     (`fetch(url).then(...)` with no `.catch`) is the same bug and is not
//     reported.
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

// Combinators that reject as soon as one of their inputs does. allSettled is
// deliberately absent: it never rejects.
const REJECTING_COMBINATORS = new Set(["all", "any", "race"]);

function memberName(callee) {
  return callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
    ? callee.property.name
    : null;
}

/**
 * The load's name as written ("fetch", "window.fetch", "apiGet"), or null.
 * Sees through the shapes that still reject when the load does: a
 * `.then(onFulfilled)` / `.finally()` chain, and `Promise.all/any/race` over an
 * array literal. A `.catch` link, or a `.then` with a rejection handler, means
 * the chain handles its own failure.
 */
function loadCalleeName(argument) {
  const call = unwrap(argument);
  if (!call || call.type !== "CallExpression") return null;
  const callee = unwrap(call.callee);
  const method = memberName(callee);
  if ((method === "then" && call.arguments.length < 2) || method === "finally") {
    return loadCalleeName(callee.object);
  }
  if (
    method &&
    REJECTING_COMBINATORS.has(method) &&
    unwrap(callee.object).type === "Identifier" &&
    unwrap(callee.object).name === "Promise" &&
    call.arguments[0] &&
    unwrap(call.arguments[0]).type === "ArrayExpression"
  ) {
    for (const element of unwrap(call.arguments[0]).elements) {
      const name = element && loadCalleeName(element);
      if (name) return name;
    }
    return null;
  }
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

function isInsideEffect(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunction(parent) && isEffectCallback(parent)) return true;
  }
  return false;
}

/**
 * The call a statement starts and drops: `fn();` or `void fn();`. Nothing
 * awaits it and nothing catches it. `fn().catch(...)`, `await fn()` and
 * `const p = fn()` are not this shape: they hand the rejection somewhere.
 */
function droppedCall(statement) {
  let expression = unwrap(statement.expression);
  if (expression.type === "UnaryExpression" && expression.operator === "void") {
    expression = unwrap(expression.argument);
  }
  return expression.type === "CallExpression" ? expression : null;
}

function isUseCallback(call) {
  const callee = unwrap(call.callee);
  return (
    (callee.type === "Identifier" && callee.name === "useCallback") ||
    memberName(callee) === "useCallback"
  );
}

/**
 * The function a name in `scope` refers to, when it is defined in a function
 * scope of this file: `function fn() {}`, `const fn = async () => {}` /
 * `function () {}`, or `const fn = useCallback(async () => {}, deps)`. Module-
 * level functions are not resolved (see the limits in the header).
 */
function resolveLocalFunction(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (!variable) continue;
    if (current.type === "module" || current.type === "global") return null;
    const def = variable.defs[0];
    if (!def) return null;
    if (def.type === "FunctionName") return def.node;
    if (def.type !== "Variable" || !def.node.init) return null;
    const init = unwrap(def.node.init);
    if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
      return init;
    }
    if (init.type === "CallExpression" && isUseCallback(init)) {
      const fn = init.arguments[0] && unwrap(init.arguments[0]);
      return fn && (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression")
        ? fn
        : null;
    }
    return null;
  }
  return null;
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

    // Functions an effect calls fire-and-forget, and the unguarded awaits
    // found in functions that are not (yet known to be) effect-run. Both are
    // collected over the whole file and matched at the end, because the
    // effect that calls a function usually comes after its definition.
    const droppedFromEffect = new Set();
    const pending = [];

    function report(node, callee) {
      if (!hasExemption(node)) {
        context.report({ node, messageId: "unguardedEffectFetch", data: { callee } });
      }
    }

    return {
      ExpressionStatement(statement) {
        const call = droppedCall(statement);
        if (!call) return;
        const callee = unwrap(call.callee);
        if (callee.type !== "Identifier" || !isInsideEffect(statement)) return;
        const fn = resolveLocalFunction(sourceCode.getScope(call), callee.name);
        if (fn) droppedFromEffect.add(fn);
      },

      AwaitExpression(node) {
        const callee = loadCalleeName(node.argument);
        if (!callee) return;

        let guarded = false;
        let crossedFunction = false;
        const crossed = [];
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
              if (!guarded) report(node, callee);
              return;
            }
            crossed.push(parent);
            crossedFunction = true;
          }
        }
        if (!guarded) pending.push({ node, callee, crossed });
      },

      "Program:exit"() {
        for (const { node, callee, crossed } of pending) {
          if (crossed.some((fn) => droppedFromEffect.has(fn))) report(node, callee);
        }
      },
    };
  },
};
