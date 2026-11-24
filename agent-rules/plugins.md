# Plugins

Read this before changing anything under `packages/plugins/`, or adding a plugin or a tool. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

## Plugin Integration Contract

Every plugin in `KNOWN_PINCHY_PLUGINS` must be classified as external or internal and have matching test/plumbing coverage.

External-integration plugins, such as web search, email, Odoo, and future third-party services, must have:

- Entry in `EXTERNAL_INTEGRATION_PLUGINS`.
- Mock server in `config/<suffix>-mock/` with third-party API surface and `/control/{health,reset,seed,...}` endpoints.
- `docker-compose.<suffix>-test.yml` overlay.
- Playwright config at `packages/web/playwright.<suffix>.config.ts`.
- E2E spec at `packages/web/e2e/<suffix>/<suffix>.spec.ts` covering plugin load, at least one tool round trip, audit log entries, and permission/filter behavior where relevant.
- `pnpm test:e2e:<suffix>` script in `packages/web/package.json`.
- `<suffix>-e2e` job in `.github/workflows/ci.yml` using the production `Dockerfile.pinchy` image.

Internal plugins, such as files, context, docs, and audit, must be listed in `INTERNAL_PLUGINS` and exercised by `packages/web/e2e/integration/agent-chat.spec.ts` or another E2E spec with a clear assertion comment mentioning the plugin id.

### Typecheck gate

Plugins run via `tsx` at runtime with no ahead-of-time type checking elsewhere in CI (root `pnpm build` is `next build`, which only typechecks `packages/web`; `Dockerfile.openclaw` only installs plugin deps). `pnpm typecheck:plugins` (`scripts/typecheck-plugins.mjs`, wired into the `quality` job) runs `tsc --noEmit` against every `packages/plugins/pinchy-*` plugin's own tsconfig.

Each plugin's `tsconfig.json` must be uniform so the gate is meaningful:

- `"include": ["**/*.ts"]` with **no** `exclude` — typechecks production **and** `__tests__/*.test.ts`, so vitest `expectTypeOf` contract tests are real compile-time checks instead of runtime no-ops (the earlier root-only `include: ["*.ts"]` / `exclude: ["*.test.ts"]` silently skipped every test file).
- `"compilerOptions"`: `skipLibCheck: true` (third-party `.d.ts` files otherwise break the gate) and `types: ["node", "vitest"]`, backed by an `@types/node` devDependency (`types: ["node"]` throws TS2688 without it).

The drift guard `scripts/lib/plugin-typecheck.test.mjs` (pure logic in `scripts/lib/plugin-typecheck.mjs`, run by `pnpm test:scripts`) fails fast if any plugin isn't wired this way, so a new plugin can't silently escape the gate — the read-side sibling of the no-untracked-skips / no-test-deletion guards.

### Unit test gate

Every plugin package must ship vitest unit tests and declare `"test": "vitest run"` in its package.json. The test files run twice in the CI quality job, deliberately: once inside `pnpm test` via the `../plugins/pinchy-*` include in `packages/web/vitest.config.ts` (web config), and once per package via `pnpm test:plugins` (each plugin's own config and dependencies, as run locally). Two drift guards in `packages/web/src/__tests__/lib/plugin-test-coverage.test.ts` enforce this: every plugin test file must match the include globs, and every plugin package must declare a `test` script (pnpm recursive runs silently skip packages without one).

### Every plugin `fetch()` passes a signal

An unbounded `fetch` has no failure mode that looks like a bug — the call simply never returns. A Pinchy container mid-deploy, or a blackhole that swallows packets without an RST, leaves the plugin waiting forever, and in `pinchy-audit`'s `before_tool_call` hook that stalls every tool call of every agent with nothing in any log naming the cause.

`packages/web/src/__tests__/lib/plugin-fetch-timeout-coverage.test.ts` requires a `signal` on every `fetch()` in plugin production code. It exists because the change that added the 15 original timeouts also wrote, in a comment, that the mailbox providers "bound themselves separately (see graph-adapter.ts, gmail-adapter.ts, imap-adapter.ts)" — and `gmail-adapter.ts` did not: it reaches Gmail through googleapis, whose transport documents `timeout` as "No timeout by default". Prose asserted coverage the code lacked, and nothing could contradict it. Same argument as § "A Hand-Maintained List That Mirrors Code Will Be Wrong".

Three things to know before editing it:

- **Pick the bound from the call's legitimate worst case, not from a latency budget.** Too long merely delays an error; too short turns working calls into failures that read as product bugs. That asymmetry is why the vision API sits at 120s hosted / **300s for Ollama** — the offline path pays a model load before decoding starts, and a shared 30s bound would break exactly the self-hosted deployments Pinchy promises to support. Pinchy-internal, same-Docker-network calls use 10s; external APIs 30s; anything that streams a file body gets its own larger bound (`ATTACHMENT_TIMEOUT_MS`), because an AbortSignal covers the body read, not just the response headers.
- **Never write `init.signal ?? AbortSignal.timeout(...)`.** It reads as a harmless escape hatch and is a trap: the first caller to pass a cancellation signal silently loses the timeout, and no test can see it. Both wrappers here (`GraphAdapter.req`, `fetchWithRetry`) type `signal` out of their options and take a `timeoutMs` instead. Create the signal **inside** a retry loop, too, so each attempt gets a fresh bound rather than all attempts sharing one deadline the first one spent.
- **It sees `fetch` and nothing else.** A plugin reaching the network through another transport is invisible to it — today `gmail-adapter.ts` (googleapis/gaxios, bounded by its `timeout` option) and `imap-adapter.ts` (imapflow, `connectionTimeout`/`socketTimeout`). It also checks only that a signal is passed, never that the value is sane. Both limits are covered by per-call unit tests instead. Verify a change to the guard with a canary — delete a `signal:` from a plugin, watch it name that exact file and line, put it back.

### A Failing Tool Result Needs `details.error`, Not Just `isError`

OpenClaw strips the MCP `isError` flag before forwarding a tool result to `/api/internal/audit/tool-use` (#404), so the audit route's only remaining failure signal is `result.details.error` — see the three-source precedence comment in that route. A tool that fails while setting only `isError: true` is written to the audit trail as **`outcome: success`**. The failure is not merely unlogged; it is logged as its opposite, which is worse than silence for anyone reading the trail afterwards. pinchy-odoo and pinchy-email carried a `toolError()` helper for this; five other plugins did not.

Every plugin now routes error results through its own `toolError(text)` helper, and `packages/web/src/__tests__/lib/plugin-tool-error-details-drift.test.ts` (scan in `plugin-error-details-extraction.ts`) enforces it by AST-walking each `packages/plugins/pinchy-*/index.ts`.

Three details are load-bearing, each because the first draft got it wrong and a canary caught it:

- **The scan unwraps `as const` and parentheses.** An `expr.kind === TrueKeyword` test skips `isError: true as const` entirely — and pinchy-email's session-less tool stub is written exactly that way, so the strict check silently exempted one of the very results it was written to cover.
- **A computed `isError` is flagged, not waved through.** `isError: result.isError` is how `pinchy_web_fetch` shipped without `details.error` in the first place. A scan that judges only the literal `true` cannot see that shape come back, so it is reported as `dynamic-is-error`: branch on the flag and return `toolError(...)` on the error side.
- **An unreadable `index.ts` throws.** Every assertion here is an _absence_, so a failed read and a clean file are the same empty list — returning `[]` would turn the guard green for a plugin it never opened. This is the one place it must diverge from `deriveToolsFromSource`, where an empty list turns the manifest comparison red instead. A corpus floor (`checked >= 10`, against 14 present when this landed) covers the same failure one level up.

Verify a change to the scan by reproduction, not by reading it: break one plugin result, watch the guard name that plugin, put it back. The `scanErrorResults` fixtures in the guard's second `describe` pin all four shapes above.

Known limitation: the scan reads `index.ts` only, matching `deriveToolsFromSource`. A plugin that builds an MCP result in a sibling module escapes it. Nothing does today — pinchy-web's `web-fetch.ts` returns an internal `{ content: string; isError }` DTO that `index.ts` translates through `toolError()`.

### Tool dispatch coverage

Every plugin tool must be covered at three layers:

1. **`openclaw.plugin.json#contracts.tools`** — list every tool name. OpenClaw 5.3+ silently ignores `registerTool()` calls that are not declared here. The bidirectional drift guard (`manifest-tools-drift.test.ts`) enforces that this list matches the `registerTool()` calls in `index.ts`.

2. **Drift guard** — `packages/web/src/__tests__/lib/manifest-tools-drift.test.ts` checks that `contracts.tools` and `registerTool()` are in sync. Runs in `pnpm test`.

3. **Behavior test** — at least one tool per plugin must have an E2E test that:
   a. Sends a chat message containing a trigger string handled by `fake-ollama-server.ts`.
   b. The fake LLM returns a deterministic `tool_calls` response for that tool.
   c. The test asserts the audit entry appears, either via a literal `/api/audit?eventType=tool.<toolName>&limit=10` query or via the shared `pollAuditForTool({ toolName, agentId })` helper in `packages/web/e2e/shared/dispatch-probe.ts`.

   The coverage guard (`plugin-tool-coverage.test.ts`) scans all `*.spec.ts` files for both `eventType=tool.<toolName>` and `pollAuditForTool(... toolName: "<toolName>" ...)` patterns. If a plugin has tools but no matching E2E assertion, CI fails there.

   **A probe inside a skipped test does not count.** The scan drops matches inside `test.skip` / `test.describe.skip` / `.todo` / `.fixme` / `xit` / `xdescribe` blocks (`extractCoveredTools` in `plugin-tool-extraction.ts`, unit-tested in `plugin-tool-coverage-skips.test.ts`). It used to count them, and two specs kept dead probes in the tree for exactly that reason — the comments said "skipped tests count for static scans" out loud (#834). A guard a never-running test satisfies reports on the presence of a string, not on the existence of a test. `.skipIf(...)` is not a skip: it is a runtime gate, and its body still counts. When a probe is blocked on infrastructure, keep it (tracked, per the skip policy) but do not let it stand in for coverage — write one that runs, or accept that the plugin is covered by a different tool's probe.

**Recipe for adding a new tool to an existing plugin:**

1. Add `registerTool(api, schema, { name: "new_tool" }, handler)` in `index.ts`.
2. Add `"new_tool"` to `contracts.tools` in `openclaw.plugin.json`.
3. Add a `TriggerConfig` entry in `packages/web/e2e/shared/fake-ollama/fake-ollama-server.ts`.
4. Export the trigger constant from `fake-ollama-server.ts`.
5. Add a `test.describe` block (or extend an existing one) in the relevant E2E spec that sends the trigger and calls `pollAuditForTool(page, { toolName: "new_tool", agentId })` (or polls the literal `/api/audit?eventType=tool.new_tool` URL).

**Recipe for adding a brand-new plugin:**

Follow the Plugin Integration Contract above, then apply the tool dispatch coverage recipe for each tool the plugin registers.

#### Ref-based tools (opaque `_pinchy_ref` inputs)

A static `TriggerConfig` cannot cover a tool whose primary argument is an opaque `_pinchy_ref` (pinchy-odoo's `odoo_reconcile`, `odoo_schedule_activity`, `odoo_attach_file`, the record-action tools, …). The ref is minted at runtime (per connection, per record) and is unknowable when the trigger is authored, so a hard-coded ref only ever exercises the plugin's decode-rejection path — not real dispatch.

The fake-LLM instead resolves the ref **dynamically**, exactly like a real model: it first dispatches `odoo_read` (once per ref the tool needs), then reads the real `_pinchy_ref` back out of that tool-result message and reuses it in the ref-based tool. The reusable engine is `buildRefDispatchScript(probe, messages)` + `extractPinchyRefsInOrder` in `fake-ollama-server.ts`, driven by the `REF_DISPATCH_PROBES` registry (one `RefDispatchProbe` per tool: `reads` models → `toolName` with `buildArgs(refs)` → final text). Multi-ref tools work too: `odoo_reconcile` reads `account.move` then `account.payment` and reconciles on both refs positionally. All of it is unit-tested in `fake-ollama-ref-dispatch.test.ts`. Every ref tool has a probe in `odoo-agent-chat.spec.ts` (the "Odoo dispatch probe" block) asserting `outcome=success` via `pollAuditForEvent`, not just that a row exists — a broken ref still dispatches (audited `failure`).

A dedicated guard, `odoo-ref-tool-e2e-coverage.test.ts` (pinchy#791), enforces this per-tool: it auto-detects every ref-based odoo tool from the plugin source and requires each to be either E2E-covered or carry a `PENDING_E2E` exemption citing the tracking issue. `PENDING_E2E` is now **empty** — all ten ref tools are covered. A **new** ref-based odoo tool with neither coverage nor an exemption fails CI. To cover the next one: add a `RefDispatchProbe` entry (its `reads` model must be seeded in the spec's `beforeAll` and the agent granted read on it, plus whatever write/create the tool checks), add the spec probe, and confirm the guard stays green.

`odoo_reconcile` is covered via the **payment-counterpart** path only: the mock's `js_assign_outstanding_line` handler zeroes the bill's `amount_residual`, which is the sole signal the plugin's `didReconcile` trusts, so `outcome=success` proves the real verification path rather than a blind return value. The **bank-statement** counterpart path (x2many write-command expansion + journal suspense/default accounts, which real Odoo 19 makes silent-no-op-prone) is deliberately left on live verification — a naive mock of it would risk a false-green, and the payment path already discharges the tool's coverage obligation.
