# AUDIT_HMAC_SECRET: forwarding it without accusing the log of tampering

Date: 2026-08-05
Issue: follow-up to #1082 (the env-var reference and its guard)

## The gap

`docs/src/content/docs/installation.mdx` documents `AUDIT_HMAC_SECRET` as a
variable operators set in `.env`. The app really reads it — `getSecretSource()`
in `packages/web/src/lib/encryption.ts` prefers `process.env` over the file
under `ENCRYPTION_KEY_DIR`. But the shipped `docker-compose.yml` never forwards
it, so on a standard install setting it does exactly nothing.

#1082 documented the gap rather than closing it, via `READ_NOT_FORWARDED` in
`scripts/lib/env-var-reference.mjs`. This is the decision to close it.

The promise is not in one file. `guides/hardening.mdx` has a whole
`## AUDIT_HMAC_SECRET configuration` section (`openssl rand -hex 32`), a
backup-table row and an Aside; `concepts/audit-trail.mdx` makes the shared
secret a _correctness prerequisite_ for multi-instance deployments; and
`concepts/audit-trail-verification.mdx` repeats it.

## What a key swap actually does

This is the part that decides the design, so it is written down precisely.

`verifyIntegrity` (`packages/web/src/lib/audit.ts`) fetches **one** secret and
recomputes **every** row against it. So after a swap:

- Every pre-swap row lands in `invalidIds` — the bucket
  `audit-trail-verification.mdx` defines as "A field inside the row was
  changed." The product accuses its entire history of tampering.
- `chainBreakIds` stays **empty**. The chain check sits in an `else if` reached
  only when the row HMAC matched, and the stored `prev_hmac` still equals the
  predecessor's stored `row_hmac` regardless of key. The reference page's claim
  that swapping "breaks the hash chain" is therefore wrong in a way worth
  correcting: it invalidates row signatures, it does not break the chain.
- The **periodic** verifier stays green. `audit-verify-job.ts` is incremental
  from a checkpoint and seeds `prevHmac` from the stored value, so it only ever
  checks post-swap rows, under the post-swap key.

So the break is silent until an admin clicks "Verify integrity"
(`audit-log-table.tsx` calls `/api/audit/verify` with no range = everything),
plausibly during a real investigation. And it is irreversible in place: the
append-only triggers forbid re-signing.

Two mitigating facts, both load-bearing:

- `getSecretSource` requires **exactly 64 hex characters**, so the empty
  `AUDIT_HMAC_SECRET=` that `installation.mdx` shows falls back to the file. A
  bare passthrough is inert for anyone who left it blank.
- The previous key is usually **still on disk**, in the `pinchy-secrets` volume.
  Nothing consults it.

## Decision

Forward it, and make verification tell the truth. Not "forward it plus an
upgrade note" alone, and not "remove the promise".

**Against removing the promise.** The multi-instance requirement is functional,
not cosmetic: without a shared secret the same email hashes to a different
pseudonym per instance and nobody can look up a user's history from one place.
Removing the env path leaves only "mount the same file everywhere", contradicts
three other doc pages, and stays inconsistent — three of the four documented
`.env` secrets work.

**Against the upgrade note alone.** The failure is silent (see above). AGENTS.md
rejects this shape repeatedly: a gate that depends on someone remembering a note
is not a gate.

**Guard shape: warn, never refuse to start.** `secret-source.ts` exists because
of #156, where an operator rotated a secret that did not need rotating and lost
encrypted data. `evaluateDbPasswordPolicy` writes the policy down: "warn loudly,
but never refuse to start". An earlier fail-fast sketch was dropped for this.

Industry practice agrees on the substance: rotate with **overlap**, retain
historical keys, keep records signed under a previous key verifiable.

## Design

1. **Compose passthrough.** `- AUDIT_HMAC_SECRET=${AUDIT_HMAC_SECRET:-}` on the
   `pinchy` service. Inert when unset (empty ≠ 64 hex → file fallback).

2. **Verification stops lying.** When the active secret comes from the env var
   and a _different_ file secret still exists, that file secret is the known
   previous key. A row that fails under the active key is retried under it; a
   match is reported in its own bucket (`previousKeyIds`), never in
   `invalidIds`. `VerifyResult` and the `audit.integrity_check` detail carry it.

   This does not weaken tamper-evidence: the previous key is a root-owned file
   in the secrets volume, and an attacker able to write it can already write the
   database and drop the append-only triggers. Rows verified under the old key
   are reported **separately**, never merged into "valid and current".

   Limitation to document honestly: it covers env-over-file, which is the case
   the passthrough creates. An operator who overwrites the _file_ has genuinely
   destroyed the old key and nothing can recover it.

3. **Early notice.** `evaluateAuditSecretRotation` (`lib/secret-source.ts`),
   called from `server.ts`, warns on every boot while the env var supersedes a
   generated key. Same house rule as the #156 policy one function up: warn
   loudly, never refuse to start.

   Neither of the two other surfaces can carry this. The admin-triggered verify
   may be months away and plausibly mid-investigation — that lateness is the
   defect, not the report. And the periodic sweep scans **forward from a
   checkpoint**: it reports pre-rotation rows only if any were still above that
   checkpoint when the key changed, so on an instance that was quiet before the
   restart it stays 0 forever. Its `previousKeyCount` is worth recording — a
   sweep that does straddle the rotation makes it durable evidence — but it is
   not a notice.

   Repeating on every boot is deliberate. The two-key state is permanent (the
   log is append-only, so those rows never age out), and so is what the operator
   must keep doing about it: back up the volume holding the older key.

   The policy takes a boolean, never the key. #156's rule for that module is to
   surface where a secret comes from and never its value, and a signature that
   cannot accept a key cannot leak one.

4. **Docs.** Rewrite the `AUDIT_HMAC_SECRET` entries in `installation.mdx`,
   `hardening.mdx`, `reference/environment-variables.mdx` (drop the override-file
   workaround, fix the "breaks the hash chain" claim), and add a note to the
   **open** upgrade section of `guides/upgrading.mdx` — never a frozen one.

5. **Guard.** Delete the `READ_NOT_FORWARDED` entry.
   `assertReadNotForwardedAreAbsent` fails until it goes, which is the point.

## Out of scope

Per-row key identifiers (a `kid`/epoch column) are the full industry answer and
would also cover file-secret overwrites and multiple historical keys. That is a
schema migration and an HMAC version bump; this change deliberately buys most of
the value without one.
