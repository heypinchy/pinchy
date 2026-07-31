# Design: Agent Provisioning API (Issue #572)

- **Issue:** [#572](https://github.com/heypinchy/pinchy/issues/572) — Public API: programmatic agent provisioning (create/list/delete) with API-key auth
- **Branch:** `feat/572-agent-provisioning-api`
- **Date:** 2026-07-14
- **Status:** Design approved (brainstorming complete) — ready for implementation plan

---

## 1. Goal

Provide a **programmatic, non-browser** way to manage agents (create / list / get / delete) authenticated by an **API key**, resolved to a scope set, and fully audited. This is the first slice of the eventual public API.

Two converging drivers:

1. **Enterprise provisioning** — create/configure/remove agents per team/org via automation / infrastructure-as-code, not only through the UI.
2. **Reproducible demos** — the demo instance must reset to a known state on every release. DB snapshots break across weekly schema migrations, so the reset must run at the **logical/API level** against a stable contract (schema-immune).

Building the API for (2) makes us the first consumer of (1) — the best way to design a good API.

## 2. Scope of this PR (the "foundation")

- `apiKey` storage + issuance (hashed at rest), via the Better Auth `apiKey` plugin.
- A dedicated `withApiKey()` auth wrapper — scope-gated, **default-deny**, **no** automatic session resolution.
- Scopes: `agents:read`, `agents:write`, `agents:delete`.
- `api_key` as a first-class **audit actor** + the `actor_type` enum migration.
- Versioned route namespace `/api/v1/agents` (create / list / get / delete), reusing extracted service logic.
- Key-management surface: admin-only management API + a **minimal admin UI** (Settings → API Keys).

## 3. Non-goals (deliberately deferred)

- **demo-reset consumer** → separate follow-up PR + its own design (it has real complexity: preserve Smithers state + knowledge bases + user/org context; recreate role-agents from versioned definitions).
- **`update` / PATCH** over the key API (MVP is create/list/get/delete per the issue).
- **Non-agent resources** (connections, knowledge bases, users) — follow once the auth foundation is proven.
- **Public stability / versioning guarantees** — ship as an admin/token API first, graduate a documented subset later. (URL carries `v1` from day one; the _guarantee_ is a separate, later, docs concern.)
- **Rate limiting, key rotation UI** — later. Expiry (optional per key) is in scope.

---

## 4. Design decisions (from brainstorming)

### D1 — Build vs. buy: **hybrid**

Use the **Better Auth `apiKey` plugin** for the security-critical mechanics (hashing at rest, verification, expiry, revocation) — we already run Better Auth with the `admin` plugin, so this is "don't rebuild what the platform gives us" (the same principle we apply to OpenClaw). But write our **own explicit `withApiKey()` wrapper** for scope enforcement, audit writing, and actor mapping.

> **Verified 2026-07-14 against installed deps:** the plugin is a **separate package `@better-auth/api-key` (v1.6.23, matches our better-auth 1.6.23)**, imported as `import { apiKey } from "@better-auth/api-key"` — it is **not** in core `better-auth/plugins` (confirmed absent from the barrel export and the package `exports` map). D1 stands; we just add this dependency. The package advertises "sessions from API keys" as a feature — see the open questions (§7) for the two things to confirm before coding: its hashing method and whether merely registering it auto-resolves keys into `getSession()`.

**Critical:** do **not** enable the plugin's automatic session resolution. If a `x-api-key` header auto-resolved to a session, _every_ existing `withAuth`/`withAdmin` route (settings, user deletion, provider keys, integrations, chat) would silently become API-key reachable. That is the opposite of the curated, default-deny surface we're selling. The key must open **only** the routes we explicitly expose.

### D2 — Audit actor model: **machine as actor, human as separate issuer metadata**

Research across mature IAM (AWS/GCP/Azure), dev platforms (GitHub/GitLab/Stripe), and modern SaaS (Datadog/Okta/Vault) converges on one pattern: a key-driven action is logged as an **independent machine principal**, with human accountability carried in a **separate delegation field** — never merged.

For Pinchy:

- **Actor** = `actorType: "api_key"`, `actorId: <keyId>`, with an `{ id, name }` snapshot of the key.
- **Issuing admin** = separate issuer field inside `detail` (Pinchy's version of AWS `sourceIdentity` / GCP `serviceAccountDelegationInfo`).
- **Forward-compatible:** Pinchy has no service-account concept yet, so the technical owner (Better Auth `userId`) is the issuing admin. When real service accounts arrive, only the owner field moves — the actor model stays.

The rejected alternative ("key acts as the admin") is exactly what Datadog and Okta are migrating _away from_ — it breaks on staff turnover (orphaning) and gives poor attribution.

> **Revised 2026-07-15 (PR review, finding B1) — the owner moved, and the issuer field went away.**
>
> The bullet above turned out to be the load-bearing one, and its "when real service accounts arrive" was not far enough away: the halfway state it described is **not a coherent model**, and review found it doesn't survive an offboarding.
>
> The industry ships exactly two: **(1) human-owned**, where the credential carries its holder's live authority and dies with their account (GitHub PAT, Okta API token, AWS access key); **(2) machine-owned**, where it belongs to a non-human principal and survives offboarding by design (GCP service account key, Datadog org API key). No vendor ships a third — human-owned but with frozen, independent permissions outliving the human — which is precisely where "`userId` = the issuing admin, scopes = the key's own" had put us. Model 1 is only coherent for a vendor that _also_ offers service accounts, so it has an answer to "then how do I run CI?". Pinchy has no such escape hatch, and this API's own motivating use case is CI.
>
> So Pinchy takes (2) now rather than later:
>
> - `referenceId` is a constant service-account id (`PINCHY_SERVICE_ACCOUNT_ID`), not any user's id. Becomes the org id under real multi-tenancy — same shape, new value.
> - The creating admin is recorded as **provenance** in the key's `metadata`, not as authority: `{ createdBy: { id, name } }`.
> - **The `issuer` delegation field in `detail` is removed.** With no human owner, there is no delegation to record — attributing a machine's 3am deletion to whoever issued its key eighteen months ago names someone who had no part in it. The actor model itself stands exactly as designed: the key is the actor, with its `{ id, name }` snapshot.
> - Agents created via the key get `ownerId: null` for the same reason.
>
> **The cost, stated plainly:** this does _not_ solve custody. The one-time plaintext was seen only by its creator, so a departed admin may still hold a working org credential — inherent to the model; GCP has the same property. It is answered operationally, and those answers ARE the control, not garnish: a **Created by** column flagging inactive creators, and an offboarding/rotation section in the docs.
>
> Coupling worth knowing: this works because of **D1**. `createApiKey` stores `referenceId` verbatim and `verifyApiKey` never resolves it; the plugin's session-from-key hook is the one place that would (`findUserById`, UNAUTHORIZED on a miss), and `enableSessionForAPIKeys: false` stops that hook from ever being registered. Turning D1 on would break every key at once. D1 and the service-account id are one decision.

### D3 — Scopes: **three, `agents:read` / `agents:write` / `agents:delete`**

`delete` is split from `write` because deletion is irreversible and the highest-blast-radius operation on a leaked key — it deserves its own grant (least privilege, default-deny). Defining three scopes now is ~free (one extra constant; the DELETE route checks `agents:delete`) and avoids an unclean future breaking change (splitting `delete` out of `write` later would either silently grant it to existing keys or break them). The `<resource>:<action>` axis is the real extensibility mechanism (`connections:read`, `knowledge:write`, … later).

- demo-reset key → `read write delete`.
- future IaC provisioning key → `read write` (no delete). Real least-privilege.

### D4 — Route architecture: **service extraction + `/api/v1/agents`**

- **Reuse (non-negotiable, per issue):** extract the pure domain logic into service functions in `lib/agents.ts` (`createAgent()`, `listAgents()`, `getAgent()`; `deleteAgent()` already exists). Both auth worlds (session routes + key routes) call the same functions; each world does its own auth + audit _around_ them. No parallel path, no duplicated logic.
- **Namespace:** new `/api/v1/agents`, separate from the `/api/agents` session routes. **URL versioning ≠ stability guarantee** — `v1` in the path is cheap future-proofing; the documented-stable _contract_ graduates later without a URL migration.
- **Semantic difference to capture:** the session `GET /api/agents` filters by per-user visibility (`getVisibleAgents` / `getAgentWithAccess`). The key API is admin/org-scoped and sees **all** agents — the extracted `listAgents()`/`getAgent()` must support the "sees everything" case (no visibility filtering).

> **Revised 2026-07-15 (PR review, finding B3) — "all" was one agent class too many.**
>
> Org-scoped stands: the key API still ignores `visibility`/group membership, because a key acts for the organization rather than any person, so per-person visibility is meaningless for it. But **personal agents are excluded**. `agent-access.ts` states the invariant for the session path — personal agents are private to their owner, and that applies to everyone, admins included — and a machine credential has strictly less claim there than an admin does. The `scope: "all"` literal is retired in favour of `scope: "shared"`; there is deliberately no scope that returns personal agents, so a route cannot ask for one.
>
> The exclusion lives in the query, not in a route branch: `getAgent` returns `undefined` for a personal agent, indistinguishable from an unknown id, so all three endpoints answer a plain `404`. That symmetry is the point — DELETE previously answered `400 "Personal agents cannot be deleted"`, which is fine on the session route (its admin caller can already enumerate every agent) but an oracle here: probe an id, read the status, learn who has a personal agent.
>
> Worth recording, because it says something about test design: the original D4 integration test proved "the key sees what the visibility filter hides" using **a personal agent** as its example — the only one that worked, since this DB is a community instance where `effectiveVisibility` downgrades `restricted` to `all`. The test demonstrating D4 _was_ the B3 exposure.

### D5 — This-PR scope: **foundation + minimal admin UI; demo-reset separate**

Minimal admin UI (Settings → API Keys: list, create with scope selection, revoke). The decisive reason is **security, not convenience**: the plaintext key may only be shown **once** (one-time display). Creating keys via `curl` against a backend leaks the plaintext into shell history and logs — a UI shows it once and forgets it. "Admins manage keys in the UI, every action audited" is also the governance story Pinchy sells.

---

## 5. Research foundation (best practices, condensed)

**Actor model — the two-axis pattern** (actor = machine principal, credential + human = separate metadata):

| Platform       | Actor on key action                                       | Human/owner                      |
| -------------- | --------------------------------------------------------- | -------------------------------- |
| **Stripe**     | `actor.type = "api_key"`, `api_key.id` — _our exact case_ | separate                         |
| AWS CloudTrail | `type: AssumedRole` + `accessKeyId`                       | `sourceIdentity`                 |
| GCP Audit Logs | service-account email as `principalEmail`                 | `serviceAccountDelegationInfo[]` |
| GitLab         | auto-created bot user (`project_x_bot_y`)                 | creator as metadata              |
| Datadog / Okta | Service Account / Service App as actor                    | deliberately decoupled           |

Datadog and Okta are _actively migrating away_ from "key belongs to the creating admin" because it orphans on staff turnover and attributes poorly. → validates D2.

**Key hashing — HMAC-SHA256 + server-wide pepper, NOT bcrypt/scrypt/argon2:**

1. Security comes from ≥256-bit key entropy, not hash slowness — a random 256-bit key is brute-force-immune regardless of hash speed (Elastic's design rationale for salted SHA-256).
2. Only a _deterministic_ hash is indexable → **O(1) lookup on a UNIQUE index**; bcrypt/argon2's embedded random salt forces O(n) scans.
3. Auth runs on _every_ request — a deliberately slow hash is a throughput/latency killer here.
4. HMAC with an externally-held pepper stays deterministic (indexable) _and_ makes a pure DB leak worthless.

**Pinchy already has the infrastructure:** `getOrCreateSecret()` for the pepper (same mechanism as `audit_hmac_secret`), and HMAC-SHA256 is already used in the audit trail.

**Key format / UX:** speaking prefix + non-secret key-id (lookup handle) + high-entropy secret; one-time plaintext display; masked display afterward (prefix + last-4); register the prefix with GitHub/GitLab secret scanning.

Sources: Stripe/GitHub/GitLab/AWS/GCP/Azure/Datadog/Okta/Vault official docs; Elastic PR #120997; OWASP Password Storage / Secrets Management / Cryptographic Storage cheat sheets.

---

## 6. Technical design

> **Superseded in four places by the D2 and D4 revisions above (noted 2026-07-31, branch review).** The section below is left as written — it is the record of what was designed — but four of its specifics no longer describe the shipped code, and one of them would be actively re-introduced by anyone implementing from here:
>
> - **`issuer` is gone**, per D2. §6.2's `apiKeyContext (key id/name, scopes, issuer)`, §6.3's "issuer in `detail`", and §6.7's "issuer `{ id, name }`" all predate that revision. The shipped `ApiKeyContext` is `{ keyId, name, scopes }` and no audit detail carries an issuer — a key acts for the organization, so there is no delegation to record.
> - **`listAgents()` is not "all agents"**, per D4. §6.3's table says so; the shipped signature is `listAgents({ scope: "shared" })` and there is deliberately no scope that returns personal agents.
> - **The mask is not "prefix + last-4"** (§6.5, §6.6). Better Auth's `start` column holds a leading substring only, so the shipped mask is `pinchy_` + 6 characters. A last-4 would have meant storing a second fragment of the secret ourselves.
> - **§6.8's pepper was dropped**, as §7.1 records — the plugin exposes no custom-hash hook.

### 6.1 Schema

- Enable the Better Auth `apiKey` plugin → generates the `apiKey` table (id, name, prefix/start, hashed key, `userId`, permissions/scopes, `expiresAt`, `enabled`, …). Generate the Drizzle migration.
- **Migration:** extend the `actor_type` pgEnum (`packages/web/src/db/schema.ts:390`) from `["user","agent","system"]` to include `"api_key"` (Postgres `ALTER TYPE … ADD VALUE`). Update the TS union in `lib/audit.ts` (:91, :311) and `lib/audit-pdf.ts` (:6).

### 6.2 `withApiKey()` wrapper (`lib/api-auth.ts`, alongside `withAuth`/`withAdmin`)

- Reads the bearer/API-key header, verifies via the plugin, resolves the key → scopes + issuing user.
- Scope-gated: `withApiKey(["agents:write"], handler)`. Default-deny if the scope is absent → standardized 403 (same shape as `withAuth`).
- Constant-time comparison; standardized 401 on missing/invalid key. **No** session resolution.
- Passes an `apiKeyContext` (key id/name, scopes, issuer) to the handler for audit.

### 6.3 `/api/v1/agents` routes

| Method | Route                 | Scope           | Service fn                  | Audit                           |
| ------ | --------------------- | --------------- | --------------------------- | ------------------------------- |
| GET    | `/api/v1/agents`      | `agents:read`   | `listAgents()` (all agents) | —                               |
| POST   | `/api/v1/agents`      | `agents:write`  | `createAgent()`             | `agent.created` (actor=api_key) |
| GET    | `/api/v1/agents/[id]` | `agents:read`   | `getAgent()`                | —                               |
| DELETE | `/api/v1/agents/[id]` | `agents:delete` | `deleteAgent()`             | `agent.deleted` (actor=api_key) |

State-changing calls audited with `actorType:"api_key"`, `actorId:<keyId>`, `{id,name}` snapshot, issuer in `detail`.

### 6.4 Service extraction (`lib/agents.ts`)

Extract from the inline POST handler: `createAgent()` (DB insert + OpenClaw config regen + runtime wait). Extract `listAgents()` / `getAgent()` supporting the admin "sees all" case. `deleteAgent()` exists. Session routes refactored to call the same functions (keeps them DRY and proves the extraction).

### 6.5 Key-management API (session/admin)

> **Org-wide (decided during implementation, 2026-07-14):** admins manage ALL keys, not just their own. Better Auth's `listApiKeys`/`deleteApiKey` are session-scoped (no `userId`/org override; Pinchy runs no `organization` plugin), which would orphan a key once its issuing admin leaves — a governance hole. So **list + revoke run directly against the `apikey` Drizzle table** (`schema.apiKeys`), bypassing the session-scoped plugin endpoints; `create` still uses `auth.api.createApiKey` (its server-only `userId` sets the owner). Revoke = hard `db.delete`, proven to actually invalidate the key (no cache — Pinchy uses `storage: "database"`) in `settings-api-keys-revoke.integration.test.ts`.

- `POST /api/settings/api-keys` (`withAdmin`) — create via `auth.api.createApiKey`; returns plaintext **once**. Audit `api_key.created` (actor = the admin, `actorType: "user"`).
- `GET /api/settings/api-keys` — list ALL keys (direct `db.select`, org-wide), masked (prefix + last-4).
- `DELETE /api/settings/api-keys/[id]` — revoke ANY key (hard `db.delete` on `apiKeys`, org-wide — NOT session-scoped `deleteApiKey`). Audit `api_key.deleted` (`DeleteDetail { name }`).

### 6.6 Minimal admin UI (Settings → API Keys)

List (name, prefix+last-4, scopes, created, expiry, last-used) · Create dialog (name, scope checkboxes, optional expiry) · one-time-display modal · Revoke.

### 6.7 Audit additions

- New `AuditResource`: `"api_key"`. New event types: `api_key.created`, `api_key.deleted` (revocation hard-deletes the key, so `.deleted` + `DeleteDetail` per the audit convention — matches the implementation plan's Task 1.3/5.3).
- Detail snapshots per AGENTS.md: `{ id, name }` for the key; scopes; issuer `{ id, name }`; expiry.

### 6.8 Crypto

Target: `HMAC-SHA256(pepper, secret)`, pepper via `getOrCreateSecret("api_key_pepper")`, timing-safe compare. **Verify** what the Better Auth plugin does internally — if it diverges (e.g. non-deterministic or a slow hash), configure a custom hasher or reconsider the storage layer. Deps are installed in the worktree → verifiable now.

---

## 7. Open questions to verify at implementation

- **Better Auth `apiKey` plugin API:** exact `createApiKey` / `verifyApiKey` surface, header convention, permissions/scopes field, how to **disable** auto session resolution, and its **hashing method** (must reconcile with §6.8).
- **AGENTS.md conventions:** read before coding — the issue references it for secret-handling, audit payloads, shared `lib/schemas/*` request schemas, and the typed client. Follow exactly.
- **Pepper source:** `getOrCreateSecret("api_key_pepper")` vs. reusing the plugin's own secret.
- **Key format:** whether the plugin fixes the format or we can set a `pinchy_`-prefixed one.

### 7.1 Verification findings (Task 0.1, 2026-07-14)

Installed `@better-auth/api-key@1.6.23` (pinned to match `better-auth`). All evidence below was read from the installed 1.6.23 source, not from memory. Package dist lives at `node_modules/.pnpm/@better-auth+api-key@1.6.23_*/node_modules/@better-auth/api-key/dist/` — code in `index.mjs`, types in `index-CI6mGUwK.d.mts` and `types-BR70O3Q3.d.mts`. Line numbers below are into those files.

**Hashing method → classification (a): fast deterministic SHA-256, no custom-hash hook. Drop the pepper.**

- `index.mjs:2246-2248` — the default hasher is plain SHA-256, base64url-encoded (no padding), fast and deterministic:
  ```js
  const defaultKeyHasher = async (key) => {
    const hash = await createHash("SHA-256").digest(
      new TextEncoder().encode(key),
    );
    return base64Url.encode(new Uint8Array(hash), { padding: false });
  };
  ```
  (`createHash` from `@better-auth/utils/hash`, `index.mjs:5`.) Applied at `index.mjs:807` (create) and `index.mjs:1624` (verify): `const hashed = opts.disableKeyHashing ? key : await defaultKeyHasher(key);`
- The **only** hashing-related config option is `disableKeyHashing?: boolean` (default `false`) — `types-BR70O3Q3.d.mts:225`, defaulted at `index.mjs:2267`. A grep for `keyHasher|customHasher|customKeyHasher|hashKey|hasher` finds only `disableKeyHashing` and the module-level const `defaultKeyHasher`. `defaultKeyHasher` is `export`ed (`index.mjs:2393`) but there is **no config hook to inject a replacement**. So option (b) does not exist.
- **Classification (a).** SHA-256 satisfies §6.8 goals (i) entropy-based security, (ii) deterministic ⇒ O(1) UNIQUE-index lookup, (iii) fast per-request auth. **Caveat:** §6.8 goal (iv), the external pepper, is **not achievable** — no custom-hash option, so `HMAC-SHA256(pepper, secret)` cannot be wired through the plugin without abandoning the D1 hybrid (plugin owns storage). **Decision: accept the plugin's SHA-256 and drop the pepper.** This is acceptable because generated keys are 64 random `[a-zA-Z]` chars (`defaultKeyLength: 64` at `index.mjs:2263`; generator uses `a-z`,`A-Z` at `index.mjs:2296`) ≈ 52^64 ≈ 2^365 bits of preimage entropy — a leak of the SHA-256 column is not brute-forceable even without a pepper.
- **Task 1.1 instruction:** do **not** set `disableKeyHashing`; do **not** attempt a custom hasher (none exists). Update §6.8's target: keys are hashed-at-rest (SHA-256) and indexable, but no pepper.

**Session resolution (D1) → registering `apiKey()` does NOT auto-resolve keys into `getSession()` by default.**

- The plugin registers a `before` hook that can inject a session from an API-key header, but its matcher only fires when `findApiKeyAndConfig` returns a key, and that function **skips every config whose `enableSessionForAPIKeys` is falsy**:
  - `index.mjs:2310-2312`: `for (const config of configurations) { if (!config.enableSessionForAPIKeys) continue; const key = getApiKeyFromConfig(ctx, config); ... }`
  - `index.mjs:2329-2330`: `hooks: { before: [{ matcher: (ctx) => !!findApiKeyAndConfig(ctx), ...`
- `enableSessionForAPIKeys` **defaults to `false`** — `index.mjs:2285`: `enableSessionForAPIKeys: config?.enableSessionForAPIKeys ?? false,`. While off, the session-injection block (`ctx.context.session = session; if (ctx.path === "/get-session") return session;`, `index.mjs:2375-2376`) is unreachable.
- Header default: `apiKeyHeaders: config?.apiKeyHeaders ?? "x-api-key"` (`index.mjs:2260`).
- **Task 1.1 instruction:** explicitly set `enableSessionForAPIKeys: false` in `apiKey({...})` (matches the default; belt-and-suspenders against an upstream default flip). Existing `withAuth`/`withAdmin` routes stay session-only and are not key-authenticable.
- **Task 2.2 instruction:** the "can't disable" branch does **not** apply — it can be disabled and is off by default. The regression test proving `GET /api/users` rejects an `x-api-key` header is therefore **downgraded from required to recommended defense-in-depth** (cheap guard against a future accidental `enableSessionForAPIKeys: true`). Given Pinchy's security posture, keeping one small regression test is advised, but it is no longer a gating requirement.

**`verifyApiKey` signature (gate for Phase 2).** Server-only endpoint — `createAuthEndpoint.serverOnly({ method: "POST", body: verifyApiKeyBodySchema }, ...)` at `index.mjs:1951-1954`; call as `auth.api.verifyApiKey({ body })`, not a public HTTP route.

- Request body (`index-CI6mGUwK.d.mts:446-450`): `{ configId?: string; key: string; permissions?: Record<string, string[]> }`. Passing `permissions` authorizes the required permissions against the key's stored permissions (`index.mjs:1666-1669`, via `role(apiKeyPermissions).authorize(permissions)`).
- Response — **does not throw** on an invalid key; it catches internally and returns a discriminated union (`index-CI6mGUwK.d.mts:444-477`, impl `index.mjs:1988-2024`):
  - Failure: `{ valid: false, error: { message, code }, key: null }` (codes: `KEY_NOT_FOUND`, `INVALID_API_KEY`, and `KEY_DISABLED`/`KEY_EXPIRED`/`USAGE_EXCEEDED` from `validateApiKey`).
  - Success: `{ valid: true, error: null, key: Omit<ApiKey, "key"> }` — the hashed `key` is stripped at `index.mjs:2011` (`const { key: _, ...returningApiKey } = apiKey`).
- Returned `key` object fields (`index-CI6mGUwK.d.mts:640-666`): `id: string`, `name: string | null`, **`referenceId: string`** (owner), `permissions: { [k: string]: string[] } | null` (JSON-parsed at `index.mjs:2016`), `prefix`, `start`, `enabled`, `expiresAt`, `metadata`, `remaining`, rate-limit fields, `configId`, `createdAt`, `updatedAt`.
- **GOTCHA (Task 2 critical):** the owner field on the output is **`referenceId`, not `userId`** — there is no `userId` on the returned object. (`userId` appears only as a stale property in the getApiKey OpenAPI _doc_ block, `index-CI6mGUwK.d.mts:~579`, and as a server-only _input_ alias on create.) Read the principal from `result.key.referenceId`.

**`createApiKey` signature (gate for Phase 5).** Endpoint `POST /api-key/create` (`index-CI6mGUwK.d.mts:261`); also `auth.api.createApiKey({ body })`.

- Request body (`index-CI6mGUwK.d.mts:262-277`): `configId?`, `name?`, `expiresIn` (number|null, **seconds**), `prefix?`, `remaining?`, `metadata?`, `refillAmount?`, `refillInterval?`, `rateLimit*?`, `permissions?: Record<string, string[]>`, `userId?` (server-only), `organizationId?`.
  - `expiresIn` is in **seconds** (`index.mjs:584` meta "in seconds"; `getDate(expiresIn, "sec")` at `index.mjs:821`), but is range-checked against `keyExpiration.minExpiresIn`/`maxExpiresIn` which are in **days** (defaults 1 / 365) after dividing by `3600*24` (`index.mjs:785-789`) ⇒ default max life 365 days.
- Response (`index-CI6mGUwK.d.mts:406-431`, impl `index.mjs:853-858`) returns the full row spread with **`key` overridden to the PLAINTEXT key including prefix** — the one-time secret:
  ```js
  return ctx.json({ ...apiKey, key, metadata: metadata ?? null, permissions: ... });
  ```
  Plaintext field name = **`key: string`**. Only `createApiKey` returns it; verify/get/list strip it. Owner returned as `referenceId`.
- **GOTCHA (Task 5 critical):** `permissions`, `remaining`, and all `rateLimit*` fields are **server-only** — passing any of them when `ctx.request || ctx.headers` is truthy throws `SERVER_ONLY_PROPERTY` (`index.mjs:735-736`); a body `userId` is rejected when `ctx.request` is set (`index.mjs:737`). ⇒ To mint a scoped key for an arbitrary agent principal, call `auth.api.createApiKey({ body: { userId, name, prefix, permissions, expiresIn } })` **server-side with NO `headers`/`request`** in the call options. That reaches the `else` branch (`index.mjs:754-766`) where `referenceId = body.userId` and `permissions` is accepted.

**Key format / prefix.** Two ways to get a `pinchy_` prefix:

- Per-key: pass `prefix: "pinchy_"` in the create body (not server-only; accepted on any call).
- Global (recommended): set **`defaultPrefix: "pinchy_"`** in `apiKey({...})` config — used as `prefix || opts.defaultPrefix` (`index.mjs:805`) and stored (`index.mjs:817`). Type `defaultPrefix?: string` (`types-BR70O3Q3.d.mts:281`). Bounds: `minimumPrefixLength` 1 / `maximumPrefixLength` 32 (`index.mjs:2262-2263`) ⇒ `pinchy_` (7 chars) is valid. Prefix is stored as plain text and prepended to the key.

**Surprise — aggressive default per-key rate limit (flag for Task 1.1).** Each created key defaults to rate-limited **on**: 10 requests / 24h (`index.mjs:2270-2274`: `enabled: true, timeWindow: 86400000, maxRequests: 10`), written onto every row (`index.mjs:830-832`) and enforced on every `verifyApiKey` via `claimUsageInDatabase` (`index.mjs:1700-1710`). Left as-is this throttles the verify path to 10 calls/day per key. **Task 1.1 should set** `rateLimit: { enabled: false }` (or sane `maxRequests`/`timeWindow`) in the plugin config, or set per-key rate-limit fields at creation. Outside the three core questions but material to a working provisioning API.

## 8. Docs-first tasks (same PR, per CLAUDE.md)

- New reference page on docs.heypinchy.com for the agent-provisioning API (auth, scopes, endpoints, examples).
- ~~Update `packages/web/src/lib/smithers-soul.ts`~~ — **not needed** (verified 2026-07-15). The soul prompt holds no feature list and mandates `docs_list`/`docs_read` for every platform question; the `pinchy-docs` plugin scans the docs dir dynamically, so the reference page above is what teaches Smithers. Hardcoding features into the soul would violate its own core instruction ("never describe features from prior knowledge").

## 9. Follow-up (separate design)

**demo-reset consumer** — delete all agents except Smithers; recreate role-agents from versioned definitions; preserve Smithers state, knowledge bases, user/org context. First real consumer of this foundation; proves the contract end-to-end.
