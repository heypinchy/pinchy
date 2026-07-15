# Agent Provisioning API — Implementation Plan (Issue #572)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Companion design:** [`plans/2026-07-14-agent-provisioning-api-design.md`](2026-07-14-agent-provisioning-api-design.md) — read it first for the *why*. This file is the *how*.

**Goal:** Ship the API-key auth foundation: issue/verify API keys (hashed at rest), a scope-gated `withApiKey()` wrapper, `/api/v1/agents` (create/list/get/delete) reusing extracted service logic, `api_key` as a first-class audit actor, key-management API + minimal admin UI. demo-reset is a separate follow-up.

**Architecture:** Hybrid — the `@better-auth/api-key` plugin owns key storage/hashing/verification; our own `withApiKey()` wrapper owns scope enforcement + audit + actor mapping (no auto session resolution). Domain logic is extracted into `lib/agents.ts` service functions called by *both* the session routes and the new `/api/v1` routes.

**Tech Stack:** Next.js 16 route handlers, Better Auth (`admin` + new `@better-auth/api-key`), Drizzle/Postgres, Zod schemas in `lib/schemas/*`, Vitest. Follow `AGENTS.md`: `parseRequestBody`, audit every state change with `outcome` + `{id,name}` snapshots, shared schemas imported by route *and* client, typed helpers from `lib/api-client.ts`, TDD (no untracked skips/deletions).

**Conventions for every task:** TDD order = write failing test → run it, confirm the *expected* failure → minimal implement → run, confirm pass → `pnpm -C packages/web test <file>` green → commit (`feat:`/`test:`/`refactor:`/`docs:`). Never `it.skip`/`it.todo` without a `#NNN` ref. Keep audit `detail` < 2048 bytes, no plaintext PII.

---

## Phase 0 — Verification spike (do first; resolves the two open questions from design §7)

### Task 0.1: Install `@better-auth/api-key` and verify its internals

**Files:** `packages/web/package.json` (add dep), scratch notes appended to the design doc.

**Steps (spike, not TDD — it answers design questions):**

1. `pnpm -C packages/web add @better-auth/api-key@1.6.23` (pin to match `better-auth`).
2. **Hashing method:** inspect the installed package source for how it stores keys.
   Run: `grep -rniE "hash|sha256|scrypt|bcrypt|createHash|subtle" node_modules/.pnpm/@better-auth+api-key@*/node_modules/@better-auth/api-key/dist/ | head -40`
   Decide: (a) if it uses a fast deterministic hash (SHA-256) → accept it, our design §6.8 is satisfied; (b) if it exposes a custom-hash option → configure `HMAC-SHA256(getOrCreateSecret("api_key_pepper"), key)`; (c) if it uses a slow/opaque hash with no override → record the tradeoff in the design doc and proceed (still hashed-at-rest, just no pepper/index benefit).
3. **Session resolution (the D1 security point):** find whether merely registering `apiKey()` adds an API-key path to `getSession()`.
   Run: `grep -rniE "getSession|session|x-api-key|onRequest|hooks" node_modules/.pnpm/@better-auth+api-key@*/node_modules/@better-auth/api-key/dist/*.mjs | head -40`
   Requirement: our `/api/agents` session routes must **not** become key-authenticable. If the plugin auto-resolves, find the disable option (`enableSessionForAPIKeys: false` or similar) and set it; if it can't be disabled, our `withApiKey` calls `verifyApiKey` directly and we add a test proving `GET /api/users` rejects an API key.
4. **API surface:** confirm the exact `auth.api.verifyApiKey(...)` / `auth.api.createApiKey(...)` request/response shape (permissions field, `valid` flag, returned key metadata).
   Run: `grep -rniE "verifyApiKey|createApiKey|permissions|expiresIn|prefix" node_modules/.pnpm/@better-auth+api-key@*/node_modules/@better-auth/api-key/dist/*.d.mts | head -60`
5. Append findings (hashing decision, session-resolution decision, verify/create signatures) to the design doc under §7 and commit: `docs: record @better-auth/api-key verification findings (#572)`.

**Gate:** do not start Phase 2 until the `verifyApiKey` signature and the session-resolution behavior are known — Task 2 depends on both.

**✅ Findings applied (spike done, independently verified — see design §7.1):** SHA-256 hashing with **no custom-hash hook** (pepper formally dropped); `enableSessionForAPIKeys` **defaults to `false`** (D1 holds); `verifyApiKey({ body: { key } })` returns `{ valid, error, key }` where `key` is `Omit<ApiKey,"key">` and the **owner is `key.referenceId`, NOT `userId`**; `key.permissions` is `Record<resource, action[]>|null`; plugin **default rate limit is 10 req/24h per key** (must be disabled); `createApiKey` must be called with **no `headers`/`request`** (permissions are server-only) and `expiresIn` is in **seconds**. These are folded into Tasks 1.1, 2.1, and 5.1 below.

---

## Phase 1 — Schema & audit foundation

### Task 1.1: Register `apiKey()` plugin + generate the key table migration

**Files:**
- Modify: `packages/web/src/lib/auth.ts:203-207` (plugins array), `packages/web/src/lib/auth-client.ts` (add `apiKeyClient()`)
- Generate: `packages/web/drizzle/<n>_*.sql` via `pnpm db:generate`
- Test: `packages/web/src/__tests__/lib/auth-apikey-plugin.test.ts`

**Step 1 — failing test:** assert the plugin is registered and exposes the key table shape (a light guard; the real behavior is covered by the wrapper tests). Import `auth` and assert `auth.api.createApiKey` is a function.

**Step 2:** run → fails (`createApiKey` undefined).

**Step 3 — implement:** add to the plugins array (from design D1; use the disable-session option per Task 0.1):
```ts
import { apiKey } from "@better-auth/api-key";
// ...
  plugins: [
    admin({ defaultRole: "member" }),
    apiKey({
      enableSessionForAPIKeys: false, // D1 security: keys must NOT resolve to sessions (default already false; set explicitly)
      defaultPrefix: "pinchy_",        // one-time key format
      rateLimit: { enabled: false },   // Task 0.1: plugin default is 10 req/24h PER KEY — would throttle the API; disable it
      // NO custom hasher — the plugin exposes no injection hook; SHA-256 is fixed and the pepper is dropped (design §7.1)
    }),
  ],
```
Add `apiKeyClient()` to `auth-client.ts` mirroring `adminClient()`. Then `pnpm db:generate` to emit the `apiKey` table migration; review the generated SQL.

**Step 4:** run test → pass. Also `pnpm -C packages/web test:db` to confirm the migration applies.

**Step 5 — commit:** `feat: register better-auth apiKey plugin and generate key table (#572)`

### Task 1.2: Add `api_key` audit actor type (enum migration + TS)

**Files:**
- Modify: `packages/web/src/db/schema.ts:390` (`actorTypeEnum`), `packages/web/src/lib/audit.ts:311` (`AuditLogBase.actorType`), `packages/web/src/lib/audit-pdf.ts:6` if it re-declares the union
- Generate: migration via `pnpm db:generate` (Postgres `ALTER TYPE "actor_type" ADD VALUE 'api_key'`)
- Test: `packages/web/src/__tests__/lib/audit-apikey-actor.test.ts`

**Step 1 — failing test:** `appendAuditLog({ actorType: "api_key", actorId: "key-1", eventType: "agent.created", resource: "agent:a1", detail: { name: "X" }, outcome: "success" })` resolves and the row reads back with `actorType === "api_key"` (use the existing audit test-db helper pattern from `agents-audit.test.ts`).

**Step 2:** run → fails (TS rejects `"api_key"`; enum lacks value).

**Step 3 — implement:**
```ts
// schema.ts:390
export const actorTypeEnum = pgEnum("actor_type", ["user", "agent", "system", "api_key"]);
// audit.ts:311
actorType: "user" | "agent" | "system" | "api_key";
```
`pnpm db:generate`. Note: `ADD VALUE` cannot run inside a transaction in Postgres — verify the generated migration isn't wrapped in one; if Drizzle wraps it, split into its own migration file.

**Step 4:** run → pass.

**Step 5 — commit:** `feat: add api_key audit actor type (#572)`

### Task 1.3: Add `api_key` audit resource (for key lifecycle events)

**Files:** Modify `packages/web/src/lib/audit.ts:30-31` (`AuditResource`) + `:33-86` (`AuditEventType` literals). Test: extend the Task 1.2 test file.

**Step 1 — failing test:** `appendAuditLog({ ..., eventType: "api_key.created", detail: { id, name, scopes } , outcome: "success" })` and `eventType: "api_key.deleted"` (revoke) type-check and persist.

**Step 3 — implement:** add `"api_key"` to `AuditResource`. The template-literal arms auto-provide `api_key.created`/`.updated`/`.deleted`. Revocation → `api_key.deleted` with `DeleteDetail { name }`; issuance → `api_key.created` with `{ id, name, scopes, expiresAt }`. Add the literals to `AuditEventType` if it's a flat union.

**Step 5 — commit:** `feat: add api_key audit resource and lifecycle events (#572)`

---

## Phase 2 — `withApiKey()` wrapper

### Task 2.1: Scope-gated `withApiKey` alongside `withAuth`/`withAdmin`

**Files:**
- Modify: `packages/web/src/lib/api-auth.ts` (append wrapper + types)
- Create: `packages/web/src/lib/api-key-scopes.ts` (`export const API_KEY_SCOPES = ["agents:read","agents:write","agents:delete"] as const; export type ApiKeyScope = typeof API_KEY_SCOPES[number];`)
- Test: `packages/web/src/__tests__/lib/with-api-key.test.ts`

**Step 1 — failing tests (one per behavior, all in one file):**
- no key header → 401 `{ error: "Unauthorized" }`
- invalid key (mock `verifyApiKey` → `{ valid: false }`) → 401
- valid key missing required scope → 403 `{ error: "Forbidden" }`
- valid key with scope → calls handler, receives `apiKeyContext` `{ keyId, name, scopes, issuerUserId }`
Mock `@/lib/auth`'s `auth.api.verifyApiKey` the same way `agents-audit.test.ts` mocks `getSession`.

**Step 3 — implement** (finalize `verifyApiKey` call shape from Task 0.1):
```ts
import { auth } from "@/lib/auth";
import type { ApiKeyScope } from "@/lib/api-key-scopes";

export type ApiKeyContext = { keyId: string; name: string; scopes: ApiKeyScope[]; issuerUserId: string };
type ApiKeyHandler<C> = (req: NextRequest, ctx: C, key: ApiKeyContext) => Promise<NextResponse> | NextResponse;

function readApiKey(req: NextRequest): string | null {
  const h = req.headers.get("Authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return req.headers.get("x-api-key");
}

export function withApiKey<C = unknown>(required: ApiKeyScope[], handler: ApiKeyHandler<C>) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    const key = readApiKey(req);
    if (!key) return unauthorized();
    const res = await auth.api.verifyApiKey({ body: { key } }); // shape per Task 0.1
    if (!res?.valid || !res.key) return unauthorized();
    const scopes = extractScopes(res.key.permissions); // permissions is Record<resource, action[]>|null (e.g. { agents: ["read","write"] }); flatten to ApiKeyScope[] (["agents:read","agents:write"]); null → []
    if (!required.every((s) => scopes.includes(s))) return forbidden();
    return handler(req, ctx, {
      keyId: res.key.id, name: res.key.name ?? "", scopes, issuerUserId: res.key.referenceId, // Task 0.1: owner is `referenceId`, NOT `userId`
    });
  };
}
```

**Step 5 — commit:** `feat: add scope-gated withApiKey wrapper (#572)`

### Task 2.2: Security regression — session routes reject API keys

**Files:** Test only: `packages/web/src/__tests__/security/session-routes-reject-api-key.test.ts`

**Step 1 — failing test:** call an existing `withAuth`/`withAdmin` route handler (e.g. `GET /api/users`) with an `x-api-key`/`Bearer` header but no session → expect 401, and assert `verifyApiKey`-based session resolution did **not** grant access. This locks in design D1.

**Step 3:** should already pass if Task 0.1 disabled session-for-api-keys; if not, add the guard. **Step 5 — commit:** `test: lock session routes against api-key auth (#572)`

---

## Phase 3 — Service extraction (`lib/agents.ts`)

### Task 3.1: Extract `createAgent()` and refactor the POST route onto it

**Files:**
- Modify: `packages/web/src/lib/agents.ts` (add `createAgent()`), `packages/web/src/app/api/agents/route.ts:58-329` (call the service)
- Test: `packages/web/src/__tests__/lib/create-agent-service.test.ts` (new) + existing `agents-create.test.ts` / `agents-audit.test.ts` must stay green

**The extraction boundary (from the codebase, do NOT move audit/session into the service):**
- **Service `createAgent(input)`:** template resolution + model selection (route lines 64-160, returning a typed error instead of logging on the capability path), the DB insert (171-192), Odoo/email permission auto-config (215-291), workspace materialization (293-308), and the OpenClaw regen + runtime wait (310-324).
- **Route keeps:** `withAdmin` wrapper + `session`, `parseRequestBody(createAgentSchema)`, all 400/422 branches, all `appendAuditLog`/`deferAuditLog` calls (now fed by the service's return value), `revalidatePath`, final `NextResponse.json(agent, 201)`.

**Step 1 — failing test:** `createAgent({...})` returns `{ agent }` (or `{ error: "template_capability_unavailable", ... }`) and performs the insert + `regenerateOpenClawConfig` (assert via mocks, mirroring `agents-audit.test.ts`).

**Step 2:** fails — `createAgent` not exported (Explore confirmed `agents.ts` has only `deleteAgent`/`updateAgent`).

**Step 3 — implement:** move the boundary logic into `createAgent()`, returning a discriminated result so the route owns audit + HTTP. Refactor the route to `const result = await createAgent(parsed.data, session.user.id)`. Keep behavior identical.

**Step 4:** run the new test **and** the full existing agents route suite — all green (this proves the refactor is behavior-preserving; do not delete any existing test — `check-test-deletions.mjs` guards this).

**Step 5 — commit:** `refactor: extract createAgent service from POST route (#572)`

### Task 3.2: Extract `listAgents()` / `getAgent()` with an admin "see all" mode

**Files:** Modify `packages/web/src/lib/agents.ts`; test `packages/web/src/__tests__/lib/list-agents-service.test.ts`.

**Key semantic (design D4):** the session `GET /api/agents` filters via `getVisibleAgents`/`getAgentWithAccess`. The key API is admin-scoped and sees everything. Implement `listAgents({ scope: "all" })` and `getAgent(id, { scope: "all" })` returning all non-deleted agents, and have the session routes keep their visibility-filtered path (or pass the user scope). TDD: assert "all" mode returns agents the visibility filter would hide.

**Step 5 — commit:** `refactor: extract listAgents/getAgent services with admin scope (#572)`

---

## Phase 4 — `/api/v1/agents` routes

> All four reuse the Phase 3 services + `withApiKey`. Show the full pattern once (Task 4.1/4.2), then 4.3/4.4 follow it. Every state-changing route audits with `actorType: "api_key"`, `actorId: keyId`, `{ id, name }` snapshot, issuer in `detail`.

### Task 4.1: `GET /api/v1/agents` (list) — scope `agents:read`

**Files:** Create `packages/web/src/app/api/v1/agents/route.ts`; test `packages/web/src/__tests__/api/v1/agents-list.test.ts`.

**Step 1 — failing test:** with a mocked valid key having `agents:read` → 200 + all agents; with a key lacking the scope → 403; no key → 401.

**Step 3 — implement:**
```ts
export const GET = withApiKey<unknown>(["agents:read"], async () => {
  const agents = await listAgents({ scope: "all" });
  return NextResponse.json({ agents });
});
```

**Step 5 — commit:** `feat: GET /api/v1/agents via api key (#572)`

### Task 4.2: `POST /api/v1/agents` (create) — scope `agents:write`

**Files:** same route file; test `agents-create.test.ts` under `__tests__/api/v1/`.

**Step 1 — failing tests:** valid `agents:write` key + valid body → 201 + agent, and audit called with `actorType:"api_key"`, `resource:"agent:<id>"`, `detail` including issuer `{ id, name }`; invalid body → 400 via `parseRequestBody(createAgentSchema)`; missing scope → 403.

**Step 3 — implement:**
```ts
export const POST = withApiKey<unknown>(["agents:write"], async (req, _ctx, key) => {
  const parsed = await parseRequestBody(createAgentSchema, req);
  if ("error" in parsed) return parsed.error;
  const result = await createAgent(parsed.data, /* ownerId */ key.issuerUserId);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 422 });
  after(() => appendAuditLog({
    actorType: "api_key", actorId: key.keyId,
    eventType: "agent.created", resource: `agent:${result.agent.id}`,
    detail: { name: result.agent.name, apiKey: { id: key.keyId, name: key.name }, issuer: { id: key.issuerUserId } },
    outcome: "success",
  }));
  return NextResponse.json(result.agent, { status: 201 });
});
```
(Reuse `createAgentSchema` — export it from a shared `lib/schemas/agents.ts` if it currently lives inline in the session route; import into both.)

**Step 5 — commit:** `feat: POST /api/v1/agents via api key (#572)`

### Task 4.3: `GET /api/v1/agents/[agentId]` — scope `agents:read`
Create `packages/web/src/app/api/v1/agents/[agentId]/route.ts`; `getAgent(id, { scope: "all" })`; 404 when absent. Test 200/404/403/401. Commit `feat: GET /api/v1/agents/[id] via api key (#572)`.

### Task 4.4: `DELETE /api/v1/agents/[agentId]` — scope `agents:delete`
Same file. Guard `agent.isPersonal` → 400 (mirror the session DELETE). `await deleteAgent(id)`, audit `agent.deleted` with `actorType:"api_key"` + issuer. Test delete/persistent-guard/scope. Commit `feat: DELETE /api/v1/agents/[id] via api key (#572)`.

---

## Phase 5 — Key-management API (session/admin)

> **✅ Org-wide list + revoke (decided 2026-07-14, supersedes the session-scoped `auth.api.listApiKeys`/`deleteApiKey` in Tasks 5.2/5.3 below):** those plugin endpoints only touch the calling admin's own keys (no `userId`/org override; no `organization` plugin), orphaning keys when an admin leaves. So **GET and DELETE run directly against `schema.apiKeys`** (Drizzle) — any admin sees/revokes any key. `POST` still uses `auth.api.createApiKey`. Revoke = hard `db.delete`, proven to actually invalidate the key (`storage: "database"`, no cache) in `settings-api-keys-revoke.integration.test.ts`. `GET` parses the JSON-string `permissions` column via a `parsePermissions` helper before `extractScopes`. Shipped as `feat: org-wide API key list + revoke (#572)`.

### Task 5.1: `POST /api/settings/api-keys` — issue a key (one-time plaintext)
**Files:** Create `packages/web/src/app/api/settings/api-keys/route.ts`; `packages/web/src/lib/schemas/api-keys.ts` (`createApiKeySchema`: `{ name: string; scopes: ApiKeyScope[]; expiresInDays?: number }`); test `__tests__/api/api-keys-create.test.ts`.

**Behavior:** `withAdmin` → `parseRequestBody(createApiKeySchema)` → `auth.api.createApiKey({ body: { name, permissions: mapScopes(scopes), expiresIn: expiresInDays ? expiresInDays * 86400 : undefined } })` **(no `headers`/`request` in the call — `permissions` is a server-only prop; passing headers throws `SERVER_ONLY_PROPERTY`, Task 0.1; `prefix` comes from the global `defaultPrefix: "pinchy_"` set in Task 1.1)** → return the plaintext key **once** `{ id, key, name, scopes }` (the plugin returns the plaintext in the response `key` field). Note `expiresIn` is in **seconds** while the schema takes `expiresInDays`. Audit `api_key.created` with `{ id, name, scopes, expiresAt }` (no plaintext key in audit). Test: 201 + plaintext returned + audit asserted; non-admin → 403.

**Commit:** `feat: issue API keys via admin endpoint (#572)`

### Task 5.2: `GET /api/settings/api-keys` — list masked
`auth.api.listApiKeys(...)` → return `{ id, name, start/prefix + last4, scopes, createdAt, expiresAt, lastRequest, enabled }`, never the secret. `withAdmin`. Test shape + masking. Commit `feat: list API keys (masked) (#572)`.

### Task 5.3: `DELETE /api/settings/api-keys/[keyId]` — revoke
Create `.../api-keys/[keyId]/route.ts`; `auth.api.deleteApiKey(...)`; audit `api_key.deleted` with `{ name }`. `withAdmin`. Test revoke + audit + 404. Commit `feat: revoke API keys (#572)`.

---

## Phase 6 — Minimal admin UI (Settings → API Keys)

### Task 6.1: `settings-api-keys.tsx` + tab wiring
**Files (per Explore §5):**
- Modify: `packages/web/src/hooks/use-tab-param.ts:6-17` (add `"apikeys"` to `SETTINGS_TABS`)
- Modify: `packages/web/src/components/settings-page-content.tsx` (add admin-gated `<TabsTrigger value="apikeys">` + `<TabsContent value="apikeys" keepMounted>` mounting the new component, following the groups block at :253-257)
- Create: `packages/web/src/components/settings-api-keys.tsx` — copy the shape of `settings-groups.tsx`: `fetchData` via `fetch("/api/settings/api-keys")`, list in a `Table`, create `Dialog` (name input + scope `Checkbox`es + optional expiry), submit via `apiPost<...>("/api/settings/api-keys", body: CreateApiKeyInput)` with `extractFieldErrors` on `ApiError`, revoke via `AlertDialog` → `apiDelete`.
- **One-time display:** after create, show the returned plaintext key in a modal with a copy button and a "you won't see this again" note; never store it in component state beyond the modal.

**Tests:** React Testing Library component test — renders list, opens create dialog, submits, shows one-time key modal, calls revoke. (Mock `apiPost`/`apiGet`/`apiDelete`.)

**Commit:** `feat: API keys admin UI (#572)`

---

## Phase 7 — Docs & Smithers (same PR, per AGENTS.md)

### Task 7.1: Docs reference page
Add a reference page under `docs/` (Astro Starlight, Diataxis "reference") for the agent-provisioning API: auth (API key header), scopes, the four `/api/v1/agents` endpoints with request/response examples, and how to issue/revoke keys in Settings. Read `PERSONALITY.md` first (English, "we" voice). Commit `docs: agent provisioning API reference (#572)`.

### Task 7.2: Update Smithers
Update `packages/web/src/lib/smithers-soul.ts` so Smithers knows Pinchy gained a programmatic, API-key-authenticated agent-provisioning API. Commit `docs: teach Smithers about the provisioning API (#572)`.

---

## Done-criteria checklist (verify before PR)
- [ ] `pnpm -C packages/web test` green; `pnpm lint`, `pnpm build` clean.
- [ ] Session routes reject API keys (Task 2.2 test).
- [ ] Every `/api/v1` + key-mgmt state change audited with correct `actorType` + `{id,name}` + `outcome` (AGENTS.md checklist).
- [ ] Shared `createAgentSchema` / `createApiKeySchema` imported by route *and* client; client uses `lib/api-client.ts` helpers.
- [ ] No untracked `.skip`/`.todo`; no net test deletions.
- [ ] Design doc §7 updated with Task 0.1 findings.
- [ ] Docs page + Smithers updated.

## Deliberately out of scope (see design §3 / §9)
demo-reset consumer · `PATCH`/update over key API · non-agent resources · public stability guarantee · rate limiting · rotation UI.
