# Audit Log Schema Versioning

The `audit_log` table uses a version-dispatched HMAC scheme to allow schema
evolution without invalidating historical entries.

## Invariants

1. **Each row has a `version` column.** v1 = legacy (rows written before this
   mechanism existed). v2+ = rows written by version-aware code.
2. **Each version has its own hash-input function** in
   [`../audit.ts`](../audit.ts). They live in `ROW_HMAC_VERIFIERS`. Never delete
   an old version's function — historical rows rely on it.
3. **For v2 and above, the `version` field is part of the hash input.** This
   prevents downgrade attacks where an attacker rewrites a v2 row's
   `version = 1` to bypass new-field verification.
4. **For v1, the hash input is the original positional array.** Since v1 rows
   predate this scheme, the hash does not include `version`. v1 rows are
   implicitly protected against downgrade because a v1 verifier given a v2
   row's extra fields would produce a non-matching hash anyway (the structure
   differs).

## Adding a new version (e.g. v3)

1. Add the new columns to the Drizzle schema with `DEFAULT` values for
   backward compatibility.
2. Generate a migration with `pnpm --filter @pinchy/web db:generate`.
3. If new columns are REQUIRED for new rows, declare a check constraint via
   Drizzle's `check()` helper inside the table builder so it lands in the
   snapshot. Pattern: `CHECK (version < N OR <col> IS NOT NULL)`.
4. Create `computeRowHmacVN()` in `audit.ts`. The hash-input array MUST:
   - Start with the same positions as the previous version (never reorder).
   - Include `N` (the version number) as a literal somewhere in the array for
     downgrade protection.
   - Append new fields at the END.
   - Use `sortKeys()` on all object values for canonicalization.
5. Register it in `ROW_HMAC_VERIFIERS[N]`.
6. Update `appendAuditLog` to choose vN for the new write path. Use a
   discriminator that cannot be accidentally triggered from older code paths
   (e.g. eventType prefix), and add a runtime guard that throws if the
   discriminator matches but required fields are missing.
7. Leave the existing vN-1 write path alone if it's still valid for some
   event types.
8. Add a regression-lock test for vN with a fixed fixture hash. See
   `__tests__/lib/audit.test.ts` for the v1/v2 examples.
9. **NEVER modify `computeRowHmacV1`, `computeRowHmacV2`, … or their fixtures.**
   If you do, every historical entry at that version becomes unverifiable.

## Forbidden operations

- Re-signing historical rows. If you feel you need this, you are wrong —
  talk to a CISO and re-read this doc.
- Deleting or modifying a `computeRowHmacVN` function or its inputs.
- Using `version` as application-layer metadata (e.g. don't render it as
  "audit schema v2" in the UI). It exists solely for hash dispatch.
- Adding fallback logic for unknown versions in the dispatch table. Unknown
  versions MUST be reported as integrity failures, not silently treated as
  v1.
