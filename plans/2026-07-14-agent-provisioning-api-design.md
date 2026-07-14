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
- **Public stability / versioning guarantees** — ship as an admin/token API first, graduate a documented subset later. (URL carries `v1` from day one; the *guarantee* is a separate, later, docs concern.)
- **Rate limiting, key rotation UI** — later. Expiry (optional per key) is in scope.

---

## 4. Design decisions (from brainstorming)

### D1 — Build vs. buy: **hybrid**
Use the **Better Auth `apiKey` plugin** for the security-critical mechanics (hashing at rest, verification, expiry, revocation) — we already run Better Auth with the `admin` plugin, so this is "don't rebuild what the platform gives us" (the same principle we apply to OpenClaw). But write our **own explicit `withApiKey()` wrapper** for scope enforcement, audit writing, and actor mapping.

**Critical:** do **not** enable the plugin's automatic session resolution. If a `x-api-key` header auto-resolved to a session, *every* existing `withAuth`/`withAdmin` route (settings, user deletion, provider keys, integrations, chat) would silently become API-key reachable. That is the opposite of the curated, default-deny surface we're selling. The key must open **only** the routes we explicitly expose.

### D2 — Audit actor model: **machine as actor, human as separate issuer metadata**
Research across mature IAM (AWS/GCP/Azure), dev platforms (GitHub/GitLab/Stripe), and modern SaaS (Datadog/Okta/Vault) converges on one pattern: a key-driven action is logged as an **independent machine principal**, with human accountability carried in a **separate delegation field** — never merged.

For Pinchy:
- **Actor** = `actorType: "api_key"`, `actorId: <keyId>`, with an `{ id, name }` snapshot of the key.
- **Issuing admin** = separate issuer field inside `detail` (Pinchy's version of AWS `sourceIdentity` / GCP `serviceAccountDelegationInfo`).
- **Forward-compatible:** Pinchy has no service-account concept yet, so the technical owner (Better Auth `userId`) is the issuing admin. When real service accounts arrive, only the owner field moves — the actor model stays.

The rejected alternative ("key acts as the admin") is exactly what Datadog and Okta are migrating *away from* — it breaks on staff turnover (orphaning) and gives poor attribution.

### D3 — Scopes: **three, `agents:read` / `agents:write` / `agents:delete`**
`delete` is split from `write` because deletion is irreversible and the highest-blast-radius operation on a leaked key — it deserves its own grant (least privilege, default-deny). Defining three scopes now is ~free (one extra constant; the DELETE route checks `agents:delete`) and avoids an unclean future breaking change (splitting `delete` out of `write` later would either silently grant it to existing keys or break them). The `<resource>:<action>` axis is the real extensibility mechanism (`connections:read`, `knowledge:write`, … later).

- demo-reset key → `read write delete`.
- future IaC provisioning key → `read write` (no delete). Real least-privilege.

### D4 — Route architecture: **service extraction + `/api/v1/agents`**
- **Reuse (non-negotiable, per issue):** extract the pure domain logic into service functions in `lib/agents.ts` (`createAgent()`, `listAgents()`, `getAgent()`; `deleteAgent()` already exists). Both auth worlds (session routes + key routes) call the same functions; each world does its own auth + audit *around* them. No parallel path, no duplicated logic.
- **Namespace:** new `/api/v1/agents`, separate from the `/api/agents` session routes. **URL versioning ≠ stability guarantee** — `v1` in the path is cheap future-proofing; the documented-stable *contract* graduates later without a URL migration.
- **Semantic difference to capture:** the session `GET /api/agents` filters by per-user visibility (`getVisibleAgents` / `getAgentWithAccess`). The key API is admin/org-scoped and sees **all** agents — the extracted `listAgents()`/`getAgent()` must support the "sees everything" case (no visibility filtering).

### D5 — This-PR scope: **foundation + minimal admin UI; demo-reset separate**
Minimal admin UI (Settings → API Keys: list, create with scope selection, revoke). The decisive reason is **security, not convenience**: the plaintext key may only be shown **once** (one-time display). Creating keys via `curl` against a backend leaks the plaintext into shell history and logs — a UI shows it once and forgets it. "Admins manage keys in the UI, every action audited" is also the governance story Pinchy sells.

---

## 5. Research foundation (best practices, condensed)

**Actor model — the two-axis pattern** (actor = machine principal, credential + human = separate metadata):

| Platform | Actor on key action | Human/owner |
|---|---|---|
| **Stripe** | `actor.type = "api_key"`, `api_key.id` — *our exact case* | separate |
| AWS CloudTrail | `type: AssumedRole` + `accessKeyId` | `sourceIdentity` |
| GCP Audit Logs | service-account email as `principalEmail` | `serviceAccountDelegationInfo[]` |
| GitLab | auto-created bot user (`project_x_bot_y`) | creator as metadata |
| Datadog / Okta | Service Account / Service App as actor | deliberately decoupled |

Datadog and Okta are *actively migrating away* from "key belongs to the creating admin" because it orphans on staff turnover and attributes poorly. → validates D2.

**Key hashing — HMAC-SHA256 + server-wide pepper, NOT bcrypt/scrypt/argon2:**
1. Security comes from ≥256-bit key entropy, not hash slowness — a random 256-bit key is brute-force-immune regardless of hash speed (Elastic's design rationale for salted SHA-256).
2. Only a *deterministic* hash is indexable → **O(1) lookup on a UNIQUE index**; bcrypt/argon2's embedded random salt forces O(n) scans.
3. Auth runs on *every* request — a deliberately slow hash is a throughput/latency killer here.
4. HMAC with an externally-held pepper stays deterministic (indexable) *and* makes a pure DB leak worthless.

**Pinchy already has the infrastructure:** `getOrCreateSecret()` for the pepper (same mechanism as `audit_hmac_secret`), and HMAC-SHA256 is already used in the audit trail.

**Key format / UX:** speaking prefix + non-secret key-id (lookup handle) + high-entropy secret; one-time plaintext display; masked display afterward (prefix + last-4); register the prefix with GitHub/GitLab secret scanning.

Sources: Stripe/GitHub/GitLab/AWS/GCP/Azure/Datadog/Okta/Vault official docs; Elastic PR #120997; OWASP Password Storage / Secrets Management / Cryptographic Storage cheat sheets.

---

## 6. Technical design

### 6.1 Schema
- Enable the Better Auth `apiKey` plugin → generates the `apiKey` table (id, name, prefix/start, hashed key, `userId`, permissions/scopes, `expiresAt`, `enabled`, …). Generate the Drizzle migration.
- **Migration:** extend the `actor_type` pgEnum (`packages/web/src/db/schema.ts:390`) from `["user","agent","system"]` to include `"api_key"` (Postgres `ALTER TYPE … ADD VALUE`). Update the TS union in `lib/audit.ts` (:91, :311) and `lib/audit-pdf.ts` (:6).

### 6.2 `withApiKey()` wrapper (`lib/api-auth.ts`, alongside `withAuth`/`withAdmin`)
- Reads the bearer/API-key header, verifies via the plugin, resolves the key → scopes + issuing user.
- Scope-gated: `withApiKey(["agents:write"], handler)`. Default-deny if the scope is absent → standardized 403 (same shape as `withAuth`).
- Constant-time comparison; standardized 401 on missing/invalid key. **No** session resolution.
- Passes an `apiKeyContext` (key id/name, scopes, issuer) to the handler for audit.

### 6.3 `/api/v1/agents` routes
| Method | Route | Scope | Service fn | Audit |
|---|---|---|---|---|
| GET | `/api/v1/agents` | `agents:read` | `listAgents()` (all agents) | — |
| POST | `/api/v1/agents` | `agents:write` | `createAgent()` | `agent.created` (actor=api_key) |
| GET | `/api/v1/agents/[id]` | `agents:read` | `getAgent()` | — |
| DELETE | `/api/v1/agents/[id]` | `agents:delete` | `deleteAgent()` | `agent.deleted` (actor=api_key) |

State-changing calls audited with `actorType:"api_key"`, `actorId:<keyId>`, `{id,name}` snapshot, issuer in `detail`.

### 6.4 Service extraction (`lib/agents.ts`)
Extract from the inline POST handler: `createAgent()` (DB insert + OpenClaw config regen + runtime wait). Extract `listAgents()` / `getAgent()` supporting the admin "sees all" case. `deleteAgent()` exists. Session routes refactored to call the same functions (keeps them DRY and proves the extraction).

### 6.5 Key-management API (session/admin)
- `POST /api/settings/api-keys` (`withAdmin`) — create; returns plaintext **once**. Audit `api_key.created`.
- `GET /api/settings/api-keys` — list, masked (prefix + last-4).
- `DELETE /api/settings/api-keys/[id]` — revoke. Audit `api_key.revoked`.

### 6.6 Minimal admin UI (Settings → API Keys)
List (name, prefix+last-4, scopes, created, expiry, last-used) · Create dialog (name, scope checkboxes, optional expiry) · one-time-display modal · Revoke.

### 6.7 Audit additions
- New `AuditResource`: `"api_key"`. New event types: `api_key.created`, `api_key.revoked`.
- Detail snapshots per AGENTS.md: `{ id, name }` for the key; scopes; issuer `{ id, name }`; expiry.

### 6.8 Crypto
Target: `HMAC-SHA256(pepper, secret)`, pepper via `getOrCreateSecret("api_key_pepper")`, timing-safe compare. **Verify** what the Better Auth plugin does internally — if it diverges (e.g. non-deterministic or a slow hash), configure a custom hasher or reconsider the storage layer. Deps are installed in the worktree → verifiable now.

---

## 7. Open questions to verify at implementation

- **Better Auth `apiKey` plugin API:** exact `createApiKey` / `verifyApiKey` surface, header convention, permissions/scopes field, how to **disable** auto session resolution, and its **hashing method** (must reconcile with §6.8).
- **AGENTS.md conventions:** read before coding — the issue references it for secret-handling, audit payloads, shared `lib/schemas/*` request schemas, and the typed client. Follow exactly.
- **Pepper source:** `getOrCreateSecret("api_key_pepper")` vs. reusing the plugin's own secret.
- **Key format:** whether the plugin fixes the format or we can set a `pinchy_`-prefixed one.

## 8. Docs-first tasks (same PR, per CLAUDE.md)

- New reference page on docs.heypinchy.com for the agent-provisioning API (auth, scopes, endpoints, examples).
- Update `packages/web/src/lib/smithers-soul.ts` so Smithers knows the platform gained a programmatic agent API.

## 9. Follow-up (separate design)

**demo-reset consumer** — delete all agents except Smithers; recreate role-agents from versioned definitions; preserve Smithers state, knowledge bases, user/org context. First real consumer of this foundation; proves the contract end-to-end.
