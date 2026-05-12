# Drizzle migrations

This directory contains the Postgres migration SQL files and Drizzle's meta-snapshot chain.

## File layout

- `NNNN_<tag>.sql` — the migration applied to the database, in journal order
- `meta/_journal.json` — ordered list of `{ idx, tag, when, breakpoints }` entries; the **journal `idx` is what Drizzle uses for ordering**, not the filename prefix
- `meta/NNNN_snapshot.json` — Drizzle's representation of the full schema state **after** migration `idx=NNNN` ran. Each snapshot has a unique `id` and a `prevId` pointing to the previous snapshot's `id`, forming a linked chain.

## Adding a migration

```bash
pnpm -C packages/web db:generate   # writes <next-idx>_<tag>.sql + matching snapshot
pnpm -C packages/web db:migrate    # applies to your local DB
```

CI runs two guards over this directory (see `src/db/__tests__/migration-snapshots.test.ts`):

1. **Chain integrity** — every snapshot's `prevId` matches the prior snapshot's `id`, every `id` is unique, and every journal entry has a matching snapshot file.
2. **Filename prefix uniqueness** — no two `*.sql` files share a `NNNN_` prefix, with one historical exception (`0024_`).

## Pitfall: parallel-branch prefix collisions

`drizzle-kit generate` picks the next prefix based on what's currently on disk. Two engineers branching from the same commit will both generate `0028_foo.sql` and `0028_bar.sql` locally. When both branches merge, the meta directory ends up with two `0028_*` migrations, _and_ each branch's snapshot chain has a different `id` for what claims to be the same step. Future `pnpm db:generate` invocations then fail with:

> Trying to find slot for new snapshot, but original 0028_foo / 0028_bar are pointing to a parent snapshot which is a collision

This actually shipped to `main` once for `0024_cuddly_vapor` / `0024_dark_captain_marvel` (resolved in PR #341). The prefix-collision guard in CI prevents new occurrences.

### Resolving a prefix collision before merge

If you see two `NNNN_*.sql` files with the same prefix in your branch (yours plus one from `origin/main`):

1. Rename **your** migration to the next free prefix: `git mv NNNN_yours.sql MMMM_yours.sql`
2. Edit `meta/_journal.json` — update your entry's `idx` and `tag` accordingly.
3. Rename your snapshot: `git mv meta/NNNN_snapshot.json meta/MMMM_snapshot.json`
4. Update your snapshot's `prevId` to the `id` of the snapshot that now precedes it.
5. Run `pnpm -C packages/web db:generate` — it should report "No schema changes, nothing to migrate."
6. Run `pnpm -C packages/web test src/db/__tests__/migration-snapshots.test.ts` — chain integrity must pass.

## Recovering from a broken snapshot chain

If the chain is already broken on `main` (snapshots missing or sharing UUIDs), `db:generate` is unusable until it is repaired. Recovery strategy used in PR #341:

1. **Identify the last known-good snapshot.** Walk backwards from the highest `idx` and `jq '.id, .prevId'` each file — the first one whose `prevId` resolves to a real predecessor is your anchor.
2. **For each subsequent migration**, read the SQL file and determine the structural change (DDL only — `INSERT` / `UPDATE` migrations are schema-no-op).
3. **Clone the anchor snapshot forward.** For each migration in order:
   - Generate a fresh UUID for `id`
   - Set `prevId` to the `id` of the previously-rebuilt snapshot
   - Apply the migration's structural delta to `tables` / `enums` / `views` (or leave unchanged for data-only migrations)
4. **Verify** with `pnpm -C packages/web db:generate` — it must report "No schema changes." If it wants to emit a diff, your rebuilt snapshots don't match `schema.ts`.
5. **Verify** with `pnpm -C packages/web vitest run src/db/__tests__/migration-snapshots.test.ts`.

The script that did this for PR #341 is preserved in the git history of that PR for reference, but is not committed to the tree — recovery is rare and the schema changes are inherently one-shot.
