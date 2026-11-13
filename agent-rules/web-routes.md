# Web Routes, Headers And The Typed Client

Read this before adding or changing an API route, a request schema, a client-side `fetch`, `next.config.ts` headers, or anything under `/api/internal/`. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

## Embeddable Serving Routes Need A next.config Entry

A header set by a route handler **loses** to `next.config.ts`'s `headers()`. The global `/(.*)` rule sets `X-Frame-Options: DENY`, so a file-serving route that sets `x-frame-options: SAMEORIGIN` in its own response still gets DENY on the wire: a valid `200 application/pdf` that the browser refuses to render, `net::ERR_BLOCKED_BY_RESPONSE`, blank viewer pane. It shipped twice this way — the KB citation viewer and agent-delivered artifacts (#703 / #788) — and every test was green both times, because route tests assert the header the **handler** declares.

So a route that serves embeddable content needs **two** things, and `packages/web/src/__tests__/security/frame-options-route-coverage.test.ts` fails CI when they drift apart:

- the handler's own `x-frame-options: SAMEORIGIN` (directly, or via `streamWorkspaceFile`), and
- a `{ source, headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] }` entry in `next.config.ts`, written **after** the catch-all — later rules win.

The guard derives the expected `source` from the route's file path and prints the exact line to add. It checks both directions: a serving route without an entry, and an entry without a serving route (a relaxation must not outlive its route, nor be widened to one that renders HTML). `resolveHeader`/`matchesSource` in `packages/web/src/test-helpers/next-headers.ts` model Next.js's resolution for a concrete path; they throw on `has`/`missing` rather than guess.

**The general lesson: assert the value a concrete URL resolves to, not the value a handler asked for.** The two are different questions, and only one of them is what the user's browser gets.

## `/api/internal/` Is A Security Claim, Not A Folder Name

Two gates in `packages/web/server.ts` wave the whole prefix through: the domain-lock host check (`src/server/host-check.ts`) and the CSRF gate (`src/server/csrf-check.ts`). Both do it for the same reason — a route under `/api/internal/` is bearer-token traffic from an OpenClaw plugin, arriving on a Docker-internal hostname (`pinchy:7777`) that can never match the locked public domain, with no browser anywhere in the picture.

The host check used to spell that out as a hand-written list of individual paths, and it drifted exactly the way § "A Hand-Maintained List That Mirrors Code Will Be Wrong" predicts. `/api/internal/channel-messages` was never added, so on any domain-locked install every capture POST from `pinchy-transcript` was answered `403 Forbidden: request host does not match the configured domain`. Pinchy's owned transcript — the whole point of the feature — stayed **empty in production for eleven weeks** (#599), and forensics for an unrelated incident had to fall back to `audit_log`, which stores tool params and no results. `knowledge/search` and `report-auth-failure` were missing from the list too, and would have failed the same way the moment anyone used them under a lock.

Nothing was red. The E2E stacks configure no domain, so `getCachedDomain()` returns null and the entire host check is inert — a gate that is switched off in every test cannot fail in one.

So the list is gone; the prefix itself is the rule. What that buys is worth stating plainly: a new internal plugin route is exempt the moment it exists, and there is no second place to remember. What it costs is that the prefix now has to mean what it says, which is what `packages/web/src/__tests__/security/internal-routes-gateway-auth.test.ts` enforces — every route under `app/api/internal/` calls `validateGatewayToken`, or is named in host-check's `LOOPBACK_ONLY_EXEMPT_PATHS` (today: the unauthenticated OpenClaw readiness probe, exempt for same-container loopback only).

That guard is not decoration: `POST /api/internal/audit/background-run` was a **session-authed browser** route sitting under the prefix, silently inheriting both exemptions — the CSRF one let a cross-site POST forge a `chat.background_run_completed` audit row using the visitor's own session. It moved to `/api/audit/background-run`. Put a session-authed route anywhere but here.

Two smaller rules that fall out of the same incident:

- **A rejected request must leave a trace on the Pinchy side.** The 403 was invisible to everyone but whoever read the OpenClaw container's stdout. A blocked `/api/` request now writes an `auth.host_blocked` audit row (`logHostBlocked`), mirroring the CSRF gate's `auth.csrf_blocked`. Page requests are deliberately **not** audited — a locked instance answers every crawler that finds its IP, and those rows would bury the one that matters.
- **An audit row an anonymous caller can mint needs a bound.** This is the one event a plain unauthenticated `GET` triggers — a locked instance is by definition reachable at an address that isn't its domain — and every `appendAuditLog` takes `pg_advisory_xact_lock` on one constant key, so an unbounded stream serializes _every_ audit write in the process behind itself. Same shape as `auth.scope_denied` (`claimScopeDenialSlot`, lib/api-auth.ts): one row per minute, `suppressedSinceLastEntry` carrying the volume. The window is **global, not keyed** — host, path and remote address are all caller-supplied, so a map keyed on one of them grows per request and the throttle stops throttling. `scopeDenialWindows` may key by API key only because an admin has to mint one first.
- **Two gates reading one header must read it the same way.** `readRequestHost` (`src/server/forwarded-host.ts`) is that one reading. The CSRF gate folded a multi-hop `X-Forwarded-Host` to its public first hop; the domain lock compared the whole string. A CDN in front of Caddy therefore passed one gate and was answered 403 by the other — #599's failure shape, one layer in. `__tests__/middleware/forwarded-host.test.ts` asserts the cross-gate invariant, not just each gate alone.
- **When a client gives up on a response, it must say why.** The plugin logged `capture rejected (403)` and dropped the message, while the body it already held said the domain lock had refused the Host header. Quote the body.

## Shared Schemas And Typed Client

For state-changing API routes, define request schemas in `packages/web/src/lib/schemas/<feature>.ts` and import them from BOTH the route handler (for `parseRequestBody`) and the client component (for typed request bodies via `z.infer`).

Use the typed helpers in `packages/web/src/lib/api-client.ts` (`apiPost`, `apiPatch`, `apiPut`, `apiDelete`, `apiGet`) instead of raw `fetch` in client components. They throw `ApiError` on non-2xx responses, which components catch and surface via `toast.error(errorMessage(e, "<fallback>"))`.

This makes contract drift between client payload and server schema a compile-time error rather than a runtime 400.

### The promise had no guard, so it was half-kept

That paragraph sat here while the tree drifted the other way: the 2026-08-04 review (#1075) counted **43 mutating raw fetches across 19 files** against 23 files that had adopted the helper — three of them using both side by side. `JSON.stringify(anything)` type-checks, so nothing was ever red.

What it cost is not only the missing type. `send()` reads the route's error contract and raises an `ApiError` carrying the server's own wording; a hand-rolled `if (!res.ok)` almost always threw that away. `settings-users.tsx` showed "Failed to revoke invite. Please try again." while the route was answering "Invite not found" — the admin could not tell a stale list from an outage. And the contract itself was read wrong: several routes answer `{ error: "<headline>", message: "<what to do about it>" }` (users/invite's seat cap, groups membership's licence gate), and `api-client` read only `error`, dropping the actionable half. It now joins the two.

`pinchy/no-raw-fetch-mutation` (`packages/web/eslint-rules/`, unit tests in `src/__tests__/eslint/`) is the guard. It reports `fetch(url, { method: "POST" | "PUT" | "PATCH" | "DELETE" })` under `src/components/**`, `src/hooks/**` and `src/app/**/*.tsx`.

- **The exemption is per statement, not per file**: `// raw-fetch-exempt: <reason>` in the comment block directly above the call, with no code in between. A file-wide marker is exactly the blind spot #1060 closed in `require-audit-log` — one legitimate raw fetch would clear every other one in the same file.
- **It takes a written reason, not an issue number.** A skip _defers_ work and needs somewhere for the work to live; "this call cannot use the helper" _asserts a fact_ (a multipart upload, a streamed response, a raw `Response` you need). The assertion is the artefact. Same reasoning as the `Docs-not-needed:` trailer.
- **Two limits, so nobody reads the green check as more than it is.** The rule matches a **string-literal** method — `fetch(url, { method: verb })` is not reported, because reporting it would mean guessing whether `verb` is `"GET"`. And it says nothing about GET, where a streamed or aborted read is legitimate. Writing the indirection to dodge the rule is a deliberate act, and review owns that case.
- **`ApiError.body` carries the whole parsed error payload**, for the routes that answer a field beyond `{ error, message, details }` (`/api/setup/provider` returns a `docs` link with its 400). Without it, such a caller would drop back to a raw `fetch` and hand-roll the contract again — which is the drift this module exists to stop.
- **Prefer `errorMessage(e, "<fallback>")` over a bare `e.message` in a catch.** `ApiError.message` falls back to a deliberately generic sentence when the route sent no wording at all, and a component almost always knows something more useful. Two files had already grown a private copy of this helper before it was extracted.

One consequence worth knowing before the next migration: typing a payload against the route's schema surfaces drift that was previously invisible. This one turned up four cases — `visibility` and `role` typed as bare `string` on their way into an enum column, an untyped `Record<string, unknown>` patch body, and a `templateId` that could be `null` at the call site. Narrow the source (the DB `CHECK` constraints in `db/enums.ts` are the evidence) rather than casting at the boundary.

Test fetch mocks go through `jsonResponse(body, { status })` in `packages/web/src/test-helpers/fetch.ts`. `send()` reads the body with `res.text()`, which a hand-rolled `{ ok: true, json: async () => x } as Response` does not have — and the failure is a rejected promise deep inside the helper rather than an assertion naming the missing method.

Two smaller rules the first review of this change turned up, both of which every gate was green on:

- **A catch that surfaces text to the user takes `errorMessage(e, "<fallback>")`, never `e.message`.** Migrating a call site changes what its catch can _see_: before, the handler threw its own `new Error(<curated copy>)`, so `e.message` was always copy; afterwards the same catch also receives a network `TypeError`, whose message is `"Failed to fetch"`. `setup-form.tsx` shipped that string onto the first screen a new install shows. `errorMessage` is unit-tested directly (`__tests__/lib/api-client.test.ts`) rather than only through its callers.
- **Typing a payload is not licence to invent a value for it.** `uid: connectionResult?.uid ?? 0` type-checks and can only ever produce a 400, because the route requires `.positive()` — a 400 that reads as a credential problem. Guard, or narrow the source; `??` at the call site is the boundary cast this section exists to remove.

## A load started from an effect catches its own failure

Nothing awaits the promise a `useEffect` starts, so a load there without a `catch` fails in two bad ways at once. In the browser, the list stays empty and reads exactly like an empty result. On the audit table that was "nothing was logged". On the agent permission sections it was "this agent has no access", and a save from that state replaced the real grants. In a test run, the rejection surfaces as a suite-level unhandled error. It ends `pnpm test` with exit 1 while every test passes, and only when the effect outlives its test's fetch mock, so it shows up in a full run and not in isolation. #1212 fixed four of these by hand and left three. #1216 fixed those three and added the guard.

`pinchy/no-unguarded-effect-fetch` reports an `await fetch(...)` / `await apiGet(...)` (or another api-client helper) in a function that runs from a `useEffect` body, unless a `try` **in that same function** has a `catch` around it. The shape to copy is in `audit-log-table.tsx`:

- An `AbortController` that the cleanup aborts.
- `apiGet(url, { signal })`.
- A catch that stays silent when `signal.aborted` and otherwise calls `toast.error(errorMessage(err, …))`.

Decide whether something is an abort from `signal.aborted` alone, never from `err.name`. When the failed load backs an editor, don't render the editor and don't report "no config" upward.

Staying silent is only half of it: the form that holds the section must also tell "not reported yet" apart from "reported no access". `AgentSettingsPermissions` keeps an Odoo or email grant `undefined` until its section reports. Until then the agent's saved `odoo_*` / `email_*` tools stay in `allowedTools` (and so do their confirmations), and the draft carries `integrationsLoaded: false`, which stops the page from sending `DELETE /api/agents/:id/integrations`. Without that, a failed load plus any unrelated tick on the Permissions tab wiped every integration grant on save.

The same holds one level up. Which sections belong on the tab is decided by the connection list, so the page passes `connections={null}` while `GET /api/integrations` has not succeeded, and the tab then treats both grants as not reported and says so in an alert. An empty array there would mean "this workspace has no integrations", which is exactly the wrong answer to a failed load. The saved tools that stand in for an unreported section are keyed by content, not by the agent object: the page refetches the agent after every save, before the sections reload, and a fresh array would re-emit the form with a section's stale pre-save dirty flag.

- **The exemption is per statement, with a written reason**: `// unguarded-load-exempt: <reason>` directly above the awaited statement. It is the same contract as `raw-fetch-exempt`, and for the same reason: the marker asserts a fact rather than deferring work.
- **It has three limits:**
  - It follows only functions _defined_ inside the effect, plus `useEffect`/`useLayoutEffect` bodies. An async `useCallback` that the effect merely calls is not followed yet: the fire-and-forget call is visible, but resolving it to the function it names needs a scope lookup the rule does not do.
  - It reads `await`. It sees through an awaited `.then`/`.finally` chain and `Promise.all`/`any`/`race([...])`, but a `.then()` chain that is never awaited and has no `.catch` slips through.
  - It checks that a catch exists, never what the catch does. An empty `catch {}` passes, and review owns that case.
