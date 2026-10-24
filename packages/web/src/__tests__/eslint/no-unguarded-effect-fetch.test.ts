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
  ],
  invalid: [
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
  ],
});
