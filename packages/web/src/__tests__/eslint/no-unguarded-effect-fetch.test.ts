import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-unguarded-effect-fetch.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const CLIENT = "/repo/packages/web/src/components/audit-log-table.tsx";

tester.run("no-unguarded-effect-fetch", rule, {
  valid: [
    // A load whose own chain ends in .catch handles its failure.
    {
      code: `useEffect(() => {
        (async () => {
          const data = await fetch("/api/x").then((r) => r.json()).catch(report);
        })();
      }, []);`,
      filename: CLIENT,
    },
    // .then with a rejection handler handles it too.
    {
      code: `useEffect(() => {
        (async () => {
          await apiGet("/api/x").then(set, report);
        })();
      }, []);`,
      filename: CLIENT,
    },
    // allSettled never rejects.
    {
      code: `useEffect(() => {
        (async () => {
          const results = await Promise.allSettled([apiGet("/a"), apiGet("/b")]);
        })();
      }, []);`,
      filename: CLIENT,
    },
    // The shape the rule asks for: a catch around the awaited load.
    {
      code: `useEffect(() => {
        const controller = new AbortController();
        void (async () => {
          try {
            const data = await apiGet("/api/audit", { signal: controller.signal });
            setEntries(data);
          } catch (err) {
            report(err);
          } finally {
            setLoading(false);
          }
        })();
        return () => controller.abort();
      }, []);`,
      filename: CLIENT,
    },
    // A named async function declared inside the effect, guarded.
    {
      code: `useEffect(() => {
        async function load() {
          try {
            const res = await fetch("/api/x");
            set(await res.json());
          } catch (err) {
            report(err);
          }
        }
        load();
      }, [id]);`,
      filename: CLIENT,
    },
    // A catch further out in the same effect still guards the inner await.
    {
      code: `useEffect(() => {
        (async () => {
          try {
            try {
              await apiGet("/api/x");
            } finally {
              done();
            }
          } catch (err) {
            report(err);
          }
        })();
      }, []);`,
      filename: CLIENT,
    },
    // An await in an event handler is not an effect: whoever calls it owns
    // the rejection.
    {
      code: `async function handleExport() { const res = await fetch("/api/audit/export"); }`,
      filename: CLIENT,
    },
    // An await of something that is not a load.
    {
      code: `useEffect(() => { (async () => { await sleep(10); })(); }, []);`,
      filename: CLIENT,
    },
    // A catch in the finally-only try's catch clause is the guard, not the
    // finally — but an await inside the catch block itself is not in the try's
    // block, so it is judged on its own. Here it is guarded by an outer catch.
    {
      code: `useEffect(() => {
        (async () => {
          try {
            try { await apiGet("/a"); } catch { await apiGet("/b"); }
          } catch (err) { report(err); }
        })();
      }, []);`,
      filename: CLIENT,
    },
    // A function the effect calls fire-and-forget is followed — guarded here.
    {
      code: `function Page() {
        const fetchData = useCallback(async () => {
          try {
            await apiGet("/api/x");
          } catch (err) {
            report(err);
          }
        }, []);
        useEffect(() => { fetchData(); }, [fetchData]);
      }`,
      filename: CLIENT,
    },
    // A call-site .catch guards the call, so the callee is not followed.
    {
      code: `function Page() {
        async function load() { await apiGet("/api/x"); }
        useEffect(() => { load().catch(report); }, []);
      }`,
      filename: CLIENT,
    },
    // So does awaiting it inside a try in the effect.
    {
      code: `function Page() {
        const load = async () => { await apiGet("/api/x"); };
        useEffect(() => {
          (async () => {
            try { await load(); } catch (err) { report(err); }
          })();
        }, []);
      }`,
      filename: CLIENT,
    },
    // A function only an event handler calls is not followed: the handler
    // owns the rejection.
    {
      code: `function Page() {
        async function save() { await apiPost("/api/x", {}); }
        return <button onClick={() => save()} />;
      }`,
      filename: CLIENT,
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    },
    // A same-named function in another scope is not the one the effect calls.
    {
      code: `function Other() {
        async function load() { await apiGet("/api/x"); }
        return load;
      }
      function Page() {
        function load() { setReady(true); }
        useEffect(() => { load(); }, []);
      }`,
      filename: CLIENT,
    },
    // A fan-out whose Promise.all is awaited inside the outer try is handled
    // there: the .map callback is not where the rejection ends up.
    {
      code: `function Page() {
        const load = useCallback(async (ids) => {
          try {
            const rows = await Promise.all(ids.map(async (id) => { const r = await fetch("/x/" + id); return r.json(); }));
            setRows(rows);
          } catch (err) { report(err); }
        }, []);
        useEffect(() => { void load(ids); }, [load]);
      }`,
      filename: CLIENT,
    },
    // A timer that calls something else does not drop the load.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { const id = setTimeout(() => setReady(true), 10); return () => clearTimeout(id); }, [load]);
      }`,
      filename: CLIENT,
    },
    // Module-level functions are a documented limit and are not followed.
    {
      code: `async function loadAll() { await apiGet("/api/x"); }
      function Page() { useEffect(() => { loadAll(); }, []); }`,
      filename: CLIENT,
    },
    // Outside the configured scope the rule does nothing.
    {
      code: `useEffect(() => { (async () => { await fetch("/api/x"); })(); }, []);`,
      filename: "/repo/packages/web/src/lib/some-lib.ts",
    },
    {
      code: `useEffect(() => { (async () => { await fetch("/api/x"); })(); }, []);`,
      filename: "/repo/packages/web/src/__tests__/components/x.test.tsx",
    },
    {
      code: `useEffect(() => { (async () => { await fetch("/api/x"); })(); }, []);`,
      filename: "/repo/packages/web/src/app/api/x/route.ts",
    },
    // The exemption, with a written reason, on the awaited statement.
    {
      code: `useEffect(() => {
        (async () => {
          /* unguarded-load-exempt: best-effort prefetch, a miss changes nothing on screen */
          await fetch("/api/prefetch");
        })();
      }, []);`,
      filename: CLIENT,
    },
    // `.then(ok, onError)` hands the rejection to `onError`.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { load().then(setRows, report); }, [load]);
      }`,
      filename: CLIENT,
    },
    // A click handler is not an effect: whoever wires it owns the rejection.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        return { onClick: () => void load() };
      }`,
      filename: CLIENT,
    },
    // A timer started from a click handler is not an effect either.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        return { onClick: () => setTimeout(load, 10) };
      }`,
      filename: CLIENT,
    },
    // allSettled never rejects, so dropping it drops nothing.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { void Promise.allSettled([load()]); }, [load]);
      }`,
      filename: CLIENT,
    },
    // Only `Promise`'s combinators reject with their elements; another
    // object's `all` is just a call that takes an array.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { void cache.all([load()]); }, [load]);
      }`,
      filename: CLIENT,
    },
  ],
  invalid: [
    // Promise.all of loads is the codebase's multi-source shape; it rejects
    // when any of them does.
    {
      code: `useEffect(() => {
        (async () => {
          try {
            const [a, b] = await Promise.all([apiGet("/a"), apiGet("/b")]);
          } finally {
            setLoading(false);
          }
        })();
      }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // A .then chain is still the same load.
    {
      code: `useEffect(() => {
        (async () => {
          const data = await fetch("/api/x").then((r) => r.json());
        })();
      }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "fetch" } }],
    },
    // .finally passes a rejection through.
    {
      code: `useEffect(() => {
        (async () => {
          await Promise.race([fetch("/a")]).finally(done);
        })();
      }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "fetch" } }],
    },
    // The #1216 shape: try/finally with no catch.
    {
      code: `useEffect(() => {
        (async () => {
          try {
            const res = await fetch(\`/api/audit?\${params}\`);
            if (res.ok) setEntries(await res.json());
          } finally {
            setLoading(false);
          }
        })();
      }, [page]);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "fetch" } }],
    },
    // No try at all, named function declared in the effect.
    {
      code: `useEffect(() => {
        async function load() {
          const data = await apiGet("/api/agents/x/integrations");
          set(data);
        }
        load();
      }, [id]);`,
      filename: "/repo/packages/web/src/hooks/use-odoo-permissions.ts",
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // useLayoutEffect and React.useEffect are the same thing.
    {
      code: `useLayoutEffect(() => { (async () => { await window.fetch("/x"); })(); }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "window.fetch" } }],
    },
    {
      code: `React.useEffect(() => { (async () => { await apiGet("/x"); })(); }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // A function declaration as the effect body.
    {
      code: `useEffect(function run() { (async () => { await apiGet("/x"); })(); }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // An await inside the catch block is NOT guarded by that same catch.
    {
      code: `useEffect(() => {
        (async () => {
          try { await apiGet("/a"); } catch { await apiGet("/b"); }
        })();
      }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // Nor is one in the finally block.
    {
      code: `useEffect(() => {
        (async () => {
          try { await apiGet("/a"); } catch (e) { report(e); } finally { await fetch("/b"); }
        })();
      }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // TypeScript wrappers must not hide the call.
    {
      code: `useEffect(() => { (async () => { const r = (await apiGet<T>("/x")) as T; })(); }, []);`,
      filename: CLIENT,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // A client page is in scope.
    {
      code: `useEffect(() => { (async () => { await fetch("/x"); })(); }, []);`,
      filename: "/repo/packages/web/src/app/(app)/settings/page.tsx",
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // A bare marker is not an exemption.
    {
      code: `useEffect(() => {
        (async () => {
          // unguarded-load-exempt:
          await fetch("/x");
        })();
      }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // An exemption clears only its own statement.
    {
      code: `useEffect(() => {
        (async () => {
          // unguarded-load-exempt: the helper reports its own failures via toast
          await loadAndReport();
          await fetch("/api/ping");
        })();
      }, []);`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "fetch" } }],
    },
    // A useCallback load the effect calls fire-and-forget (the
    // settings-page shape).
    {
      code: `function Page() {
        const fetchData = useCallback(async () => {
          const res = await fetch("/api/groups");
          if (res.ok) setGroups(await res.json());
        }, []);
        useEffect(() => { fetchData(); }, [fetchData]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "fetch" } }],
    },
    // React.useCallback, a void call, and a try/finally with no catch.
    {
      code: `function Page() {
        const fetchStatus = React.useCallback(async () => {
          try {
            await Promise.all([apiGet("/a"), apiGet("/b")]);
          } finally {
            setLoading(false);
          }
        }, []);
        useEffect(() => { void fetchStatus(); }, [fetchStatus]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // A function declaration in the component, called inside a branch.
    {
      code: `function Page() {
        async function fetchUsers() { const res = await fetch("/api/users"); }
        useEffect(() => { if (ready) { fetchUsers(); } }, [ready]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // A const function expression, with TypeScript around it.
    {
      code: `function Page() {
        const load = async function (): Promise<void> { await apiGet<T>("/x"); };
        useEffect(() => { load(); }, []);
      }`,
      filename: CLIENT,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // A try/catch around the effect's call does not catch an async rejection.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { try { load(); } catch (err) { report(err); } }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // Called fire-and-forget from the effect and awaited in a handler: the
    // effect's call is still unguarded, reported once.
    {
      code: `function Page() {
        async function load() { await apiGet("/x"); }
        useEffect(() => { load(); }, []);
        async function onRetry() { try { await load(); } catch (e) { report(e); } }
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch" }],
    },
    // A .then/.finally chain hands on nothing that catches: still dropped.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // A concise effect body drops its call the same way.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => void load(), [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // The codebase's polling idiom: a concise timer callback.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { const id = setInterval(() => void load(), 3000); return () => clearInterval(id); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // A function handed to a timer by name is called and dropped by it.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // Awaited, but with no catch between the await and the effect.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { (async () => { await load(); })(); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // The deferral idiom in its concise form: the `.then` callback's rejection lands on a dropped chain.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { const c = new AbortController(); void Promise.resolve().then(() => load(c.signal)); return () => c.abort(); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // The same, with the function handed to `.then` by name.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { void Promise.resolve().then(load); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // Loads started together and dropped together.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        const other = useCallback(async () => { await apiGet("/y"); }, []);
        useEffect(() => { void Promise.all([load(), other()]); }, [load, other]);
      }`,
      filename: CLIENT,
      errors: [
        { messageId: "unguardedEffectFetch", data: { callee: "apiGet" } },
        { messageId: "unguardedEffectFetch", data: { callee: "apiGet" } },
      ],
    },
    // Awaited together, but with no catch between the await and the effect.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { void (async () => { await Promise.all([load()]); })(); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // `.then(onFulfilled)` alone catches nothing.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { load().then(setRows); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // A listener is called by the event loop, which drops what it returns.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { window.addEventListener("focus", load); return () => window.removeEventListener("focus", load); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // An explicit `void` drops the call in any callback inside the effect.
    {
      code: `function Page() {
        const load = useCallback(async () => { await apiGet("/x"); }, []);
        useEffect(() => { ids.forEach((id) => void load(id)); }, [ids, load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // A fan-out that is returned, not awaited: the try ends before it rejects.
    {
      code: `function Page() {
        const load = useCallback(async () => {
          try {
            return Promise.all(ids.map(async (id) => { await apiGet("/x/" + id); }));
          } catch (err) { report(err); }
        }, [ids]);
        useEffect(() => { void load(); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
    // allSettled never rejects, so the try around it never sees a callback's failure.
    {
      code: `function Page() {
        const load = useCallback(async () => {
          try {
            await Promise.allSettled(ids.map(async (id) => { await apiGet("/x/" + id); }));
          } catch (err) { report(err); }
        }, [ids]);
        useEffect(() => { void load(); }, [load]);
      }`,
      filename: CLIENT,
      errors: [{ messageId: "unguardedEffectFetch", data: { callee: "apiGet" } }],
    },
  ],
});
