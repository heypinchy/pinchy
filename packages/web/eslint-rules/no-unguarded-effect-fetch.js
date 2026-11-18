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
//   - A function the effect CALLS and drops — `fn();`, `void fn();`,
//     `fn().then(ok)` / `.finally(...)`, the callback of such a link
//     (`void Promise.resolve().then(() => fn())`, `.then(fn)`), each element of
//     a dropped `Promise.all/any/race([...])`, a concise `() => fn()` that is
//     the effect, a scheduler callback or a `void`, `setInterval(fn, ...)` and
//     the other SCHEDULERS, or `await fn()` with no catch between it and the
//     effect — anywhere in the effect body, where `fn` resolves (by scope,
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
// A `.map` callback whose promises go straight into an awaited
// `Promise.all/any/race` is part of the function around it: its rejection
// lands on that await, so the try around the await guards it.
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
    isPromiseCombinator(callee) &&
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
 * The local functions an expression starts and drops: `fn()`, `void fn()`,
 * that call continued by `.then(onFulfilled)` / `.finally(...)` (neither
 * catches), the callbacks of those links (`.then(fn)`, `.then(() => fn())`:
 * they reject into the same dropped chain), and every element of a dropped
 * `Promise.all/any/race([...])`. `fn().catch(...)`, `fn().then(ok, onError)`
 * and `const p = fn()` are not this shape: they hand the rejection somewhere.
 * Returns call nodes and identifiers; `markDropped` resolves both.
 */
function droppedCalls(expression) {
  const found = [];
  collect(expression);
  return found;

  function collect(expression) {
    let current = unwrap(expression);
    if (current.type === "UnaryExpression" && current.operator === "void") {
      current = unwrap(current.argument);
    }
    while (current.type === "CallExpression") {
      const callee = unwrap(current.callee);
      const method = memberName(callee);
      if ((method === "then" && current.arguments.length < 2) || method === "finally") {
        const handler = current.arguments[0] ? unwrap(current.arguments[0]) : null;
        if (handler && handler.type === "Identifier") found.push(handler);
        else if (
          handler &&
          handler.type === "ArrowFunctionExpression" &&
          handler.body.type !== "BlockStatement"
        ) {
          collect(handler.body);
        }
        current = unwrap(callee.object);
        continue;
      }
      if (callee.type === "Identifier") {
        found.push(current);
      } else if (isPromiseCombinator(callee)) {
        const list = current.arguments[0] ? unwrap(current.arguments[0]) : null;
        if (list && list.type === "ArrayExpression") {
          for (const element of list.elements) {
            if (element && element.type !== "SpreadElement") collect(element);
          }
        }
      }
      return;
    }
  }
}

/** `Promise.all` / `.any` / `.race`: they reject when one of their promises does. */
function isPromiseCombinator(callee) {
  if (callee.type !== "MemberExpression") return false;
  const object = unwrap(callee.object);
  return (
    object.type === "Identifier" &&
    object.name === "Promise" &&
    REJECTING_COMBINATORS.has(memberName(callee))
  );
}

// Callers that call a function they are handed and drop what it returns.
const SCHEDULERS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "queueMicrotask",
  "startTransition",
]);

function isScheduler(call) {
  const callee = unwrap(call.callee);
  if (callee.type === "Identifier") return SCHEDULERS.has(callee.name);
  const method = memberName(callee);
  return method === "addEventListener" || SCHEDULERS.has(method);
}

/**
 * A `.map` callback whose promises go straight into an awaited
 * `Promise.all/any/race(...)`: what it rejects with is rejected by that await,
 * so a try around the await is the try that catches it.
 */
function isAwaitedFanOut(fn) {
  const map = fn.parent;
  if (!map || map.type !== "CallExpression" || map.arguments[0] !== fn) return false;
  if (memberName(unwrap(map.callee)) !== "map") return false;
  const combinator = outerOf(map);
  if (
    !combinator ||
    combinator.type !== "CallExpression" ||
    unwrap(combinator.arguments[0]) !== map
  ) {
    return false;
  }
  if (!isPromiseCombinator(unwrap(combinator.callee))) return false;
  const parent = outerOf(combinator);
  return Boolean(parent && parent.type === "AwaitExpression");
}

/** The parent of `node`, past the wrappers `unwrap` looks through. */
function outerOf(node) {
  let parent = node.parent;
  while (parent && unwrap(parent) !== parent) parent = parent.parent;
  return parent;
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

    function markDropped(nodes) {
      for (const node of nodes) {
        const name = node.type === "Identifier" ? node.name : unwrap(node.callee).name;
        const fn = resolveLocalFunction(sourceCode.getScope(node), name);
        if (fn) droppedFromEffect.add(fn);
      }
    }

    /**
     * Walks from an await to the function that runs it. `guarded`: a try with
     * a catch in the same function encloses it (an awaited fan-out callback
     * counts as the same function). `crossed`: the functions in between.
     * `effect`: the walk reached an effect callback.
     */
    function walkToEffect(node) {
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
          if (isEffectCallback(parent)) return { guarded, crossed, effect: true };
          if (!guarded && isAwaitedFanOut(parent)) continue;
          crossed.push(parent);
          crossedFunction = true;
        }
      }
      return { guarded, crossed, effect: false };
    }

    function report(node, callee) {
      if (!hasExemption(node)) {
        context.report({ node, messageId: "unguardedEffectFetch", data: { callee } });
      }
    }

    return {
      ExpressionStatement(statement) {
        if (isInsideEffect(statement)) markDropped(droppedCalls(statement.expression));
      },

      // A concise body returns its call to whoever runs the arrow. The effect
      // itself and a scheduler drop it; an explicit `void` drops it anywhere.
      ArrowFunctionExpression(arrow) {
        if (arrow.body.type === "BlockStatement") return;
        const runner = arrow.parent;
        const dropsResult =
          isEffectCallback(arrow) ||
          (unwrap(arrow.body).type === "UnaryExpression" &&
            unwrap(arrow.body).operator === "void") ||
          (runner &&
            runner.type === "CallExpression" &&
            runner.callee !== arrow &&
            isScheduler(runner));
        if (dropsResult && (isEffectCallback(arrow) || isInsideEffect(arrow))) {
          markDropped(droppedCalls(arrow.body));
        }
      },

      // `setInterval(load, ...)`: the scheduler calls `load` and drops it.
      CallExpression(call) {
        if (!isScheduler(call) || !isInsideEffect(call)) return;
        for (const argument of call.arguments) {
          const node = unwrap(argument);
          if (node.type !== "Identifier") continue;
          const fn = resolveLocalFunction(sourceCode.getScope(call), node.name);
          if (fn) droppedFromEffect.add(fn);
        }
      },

      AwaitExpression(node) {
        const callee = loadCalleeName(node.argument);
        const { guarded, crossed, effect } = walkToEffect(node);
        if (!callee) {
          // `await fn()` with no catch between it and the effect: the effect
          // drops what `fn` rejects with, just one function further out.
          if (effect && !guarded) markDropped(droppedCalls(node.argument));
          return;
        }
        if (guarded) return;
        if (effect) report(node, callee);
        else pending.push({ node, callee, crossed });
      },

      "Program:exit"() {
        for (const { node, callee, crossed } of pending) {
          if (crossed.some((fn) => droppedFromEffect.has(fn))) report(node, callee);
        }
      },
    };
  },
};
