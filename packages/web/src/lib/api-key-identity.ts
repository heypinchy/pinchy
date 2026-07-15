/**
 * Who an Agent Provisioning API key belongs to (#572).
 *
 * ─── The model ────────────────────────────────────────────────────────────
 *
 * A Pinchy API key is owned by the ORGANIZATION, not by the admin who clicked
 * "create". It is a service-account credential: it authenticates automation
 * (CI resetting a demo instance, a provisioning script), and automation must
 * not stop working because a person changed jobs.
 *
 * The industry ships exactly two coherent models for this:
 *
 *   1. Human-owned — the credential carries its holder's live authority and
 *      dies with their account (GitHub PAT, Okta API token, Atlassian API
 *      token, AWS IAM access key).
 *   2. Machine-owned — the credential belongs to a non-human principal and
 *      survives offboarding by design (GCP service account key, Datadog org
 *      API key, Grafana/Kubernetes service accounts).
 *
 * Pinchy takes (2). Model 1 is only coherent for a vendor that ALSO offers
 * service accounts, so it has somewhere to point when you ask "then how do I
 * run CI?" — Pinchy has no such escape hatch, so Model 1 would leave the
 * product's only automation surface hanging off an employee's account.
 *
 * ─── What that costs, and where it's paid ─────────────────────────────────
 *
 * Model 2 does NOT solve custody. The plaintext key is shown exactly once, to
 * the admin who created it, so a departed admin may still hold a working org
 * credential. That is inherent to the model — GCP has the same property — and
 * it is answered operationally, not technically:
 *
 *   - `createdBy` below records who created each key, and the settings UI
 *     surfaces it (flagging creators who are no longer active).
 *   - The docs' offboarding section makes rotation part of the checklist.
 *
 * Those are not garnish. They ARE the control. Without them this model is
 * strictly weaker than Model 1.
 */

/**
 * The `referenceId` every Pinchy API key is issued against — a constant
 * service-account identifier standing in for "the organization", rather than
 * any user's id.
 *
 * ⚠️ LOAD-BEARING COUPLING WITH D1 (`enableSessionForAPIKeys: false`, see
 * lib/auth.ts). This value is not a real user, and better-auth is fine with
 * that on every path Pinchy uses: `createApiKey` stores `referenceId`
 * verbatim without validating it, and `verifyApiKey` never resolves it. The
 * ONE path that would is the plugin's session-from-key hook, which calls
 * `findUserById(apiKey.referenceId)` and throws UNAUTHORIZED on a miss — and
 * that hook is not merely skipped but never registered, because the plugin
 * gates its own matcher on `enableSessionForAPIKeys`
 * (`findApiKeyAndConfig`: `if (!config.enableSessionForAPIKeys) continue`).
 *
 * So: turning D1 on would break EVERY key at once. That fails closed, which
 * is the right direction, but it would be a mystifying failure — hence this
 * note. D1 and this constant are one decision, not two.
 *
 * Deliberately a readable literal rather than a UUID: it shows up in
 * `apikey.reference_id` and should be self-explanatory to whoever is reading
 * the table at 3am. When Pinchy grows real multi-tenancy this becomes the org
 * id — the same shape better-auth's own `references: "organization"` mode
 * uses — so the column doesn't need to change, only the value.
 */
export const PINCHY_SERVICE_ACCOUNT_ID = "pinchy:service-account";

/**
 * The human who created a key, snapshotted at creation time.
 *
 * Provenance, NOT authority: the key's permissions are its own `scopes` and
 * do not derive from this person, who may since have left. Snapshotting the
 * name (rather than joining on the id at read time) keeps the settings list
 * legible after the user row is gone — the same reasoning CLAUDE.md's audit
 * rules apply to `{ id, name }` entity refs.
 */
export type ApiKeyCreator = {
  id: string;
  name: string;
};

/** What Pinchy stores in the plugin's `metadata` column. */
export type ApiKeyMetadata = {
  createdBy?: ApiKeyCreator;
};

/**
 * Parse the `apikey.metadata` column (db/schema.ts: a `text` column holding a
 * JSON string, same as `permissions`) into the creator snapshot.
 *
 * Returns `null` for a null/empty column, invalid JSON, or a payload without
 * a well-formed `createdBy` — never throws, so one corrupt or pre-Model-2 row
 * degrades to "creator unknown" in the settings list instead of failing the
 * whole request. Callers must render that case rather than assume a creator.
 */
export function parseCreator(raw: string | null): ApiKeyCreator | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ApiKeyMetadata;
    const createdBy = parsed?.createdBy;
    if (typeof createdBy?.id !== "string" || typeof createdBy?.name !== "string") return null;
    return { id: createdBy.id, name: createdBy.name };
  } catch {
    return null;
  }
}

/**
 * The display name for an `api_key` actor in the audit trail, read from the
 * row's own `detail` snapshot. Returns null for every other actor type.
 *
 * Both audit read paths (`/api/audit` and `/api/audit/export`) resolve actor
 * names by left-joining `users`. A key is not a user — see above — so that
 * join misses for EVERY api_key row, and without this fallback the UI renders
 * a truncated opaque id in the one product surface whose entire job is telling
 * an auditor who did what.
 *
 * Joining `apikey` instead wouldn't fix it: revoking a key hard-deletes its
 * row, so precisely the trail you'd most want to read after an incident would
 * go nameless. The `{ id, name }` snapshot each writer puts in `detail` is
 * immutable and outlives the key — which is exactly why CLAUDE.md's audit
 * rules require snapshotting names alongside ids rather than joining for them.
 *
 * Returns null rather than guessing when the snapshot is absent; the caller
 * falls back to the id. An audit trail is evidence, and an honest gap in it
 * beats a plausible invention.
 *
 * Keyed off `actorType`, deliberately: plenty of USER rows legitimately carry
 * an `apiKey` in `detail` (an admin issuing or revoking one), and those must
 * keep showing the admin's name.
 *
 * Lives here rather than in `lib/audit.ts` because it is pure — no DB, no
 * imports — so audit-route tests can exercise the real thing instead of
 * having to stub it out along with that module's DB-bound exports.
 */
export function apiKeyActorName(actorType: string, detail: unknown): string | null {
  if (actorType !== "api_key") return null;
  const name = (detail as { apiKey?: { name?: unknown } } | null)?.apiKey?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}
