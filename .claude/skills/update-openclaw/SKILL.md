---
name: update-openclaw
description: Use when bumping the pinned OpenClaw core version (openclaw npm package), when preparing a Pinchy release, or when the user asks to "update OpenClaw" / "upgrade OpenClaw" / check for a newer OpenClaw version.
---

# Update the pinned OpenClaw version

## Overview

Pinchy pins the OpenClaw core runtime version in two places that a drift
guard keeps in lockstep:

- `packages/web/package.json` → `dependencies.openclaw`
- `Dockerfile.openclaw` → `RUN npm install -g openclaw@<version>`

`packages/web/src/__tests__/lib/openclaw-version-pin-drift.test.ts` greps
`Dockerfile.openclaw` for the literal `npm install -g openclaw@` line and
fails if it doesn't match `package.json`. Both places also feed
`/api/version`.

**Core principle: OpenClaw upgrades have repeatedly broken Pinchy in ways
`pnpm test`/`tsc` don't catch**, because the breakage is in runtime protocol
behavior (session keys, `tools.allow` semantics, `config.apply` timing,
plugin manifest resolution) — see the `reference_oc_*` / `reference_openclaw_*`
memory entries about past compatibility cliffs. Never treat "npm view shows a
newer version" as a green light by itself. Read the release notes for every
version between current and target first.

## Procedure

1. **Check current vs. latest.**
   ```bash
   grep openclaw packages/web/package.json
   npm view openclaw version
   npm view openclaw versions --json | tail -20   # see every point release in between
   ```

2. **Read every release's notes between current (exclusive) and target
   (inclusive)** — not just the target's diff summary, since intermediate
   point releases can carry changes too:
   ```bash
   gh release list --repo openclaw/openclaw --limit 20
   gh release view v<version> --repo openclaw/openclaw
   ```
   Read the full text, not just headline "Highlights" — the "Additional ...
   fixes" subsections often contain the entry that actually matters to us.
   Work through it against these four questions, in this order, and write
   down what you find for each before moving to step 3:

   **a. Incompatibility risk.** Anything touching session keys, `tools.allow`
   semantics, `config.apply` timing, plugin config/manifest resolution, or
   provider `baseUrl` handling — the areas that have bitten us before (see
   `reference_oc_*` / `reference_openclaw_*` memory entries). Look at
   sections titled "Sessions", "Gateway, Security, and Trust", "Plugins and
   Packaging", and any breaking/migration language anywhere else.

   **b. Resolved issues we have workarounds for.** Grep our own code for
   the upstream issue/PR numbers and version-guard comments before reading
   notes:
   ```bash
   git grep -rniE "openclaw/openclaw#[0-9]+|openclaw issue|version.?guard|workaround|TODO\(#" -- packages/ config/ | grep -vi node_modules
   ```
   For each hit, check the upstream issue state (`gh issue view <n> --repo
   openclaw/openclaw --json state,closedAt`). But **"issue closed" is
   necessary, not sufficient** — a closed issue is where naive audits go
   wrong. Before removing any workaround, confirm ALL of:

   1. **The fix shipped in a release ≤ our target pin.** Close date ≠ release
      date, and release notes often don't name the issue. When in doubt,
      inspect the actually-installed bundle in
      `node_modules/.pnpm/openclaw@<target>/node_modules/openclaw/dist` for
      the fixed code, not just the changelog.
   2. **The fix targets OUR code path**, not a sibling. Real example: openclaw
      #75534 (config.apply no-op restart, tracked on our side by #215) fixed
      OpenClaw's *own* `writeConfigFile` short-circuit — but Pinchy writes the
      config file itself and then calls `config.apply`, a different path whose
      `env.*`→default-`restart` mechanism was still present verbatim in
      2026.6.11. Issue closed, workaround NOT removable.
   3. **The workaround is actually a bug-workaround**, not a defensive
      error-UX classifier or an architectural decoupling that stays valuable
      after the bug is fixed. Real examples that are NOT removable-on-close:
      the `thought_signature` error classifier (`model-error-classifier.ts`,
      #338 — renders graceful UX whenever the upstream error surfaces, and its
      removal is gated on an *empirical* live-path condition, not the issue
      state), and the Telegram store-based `allowFrom` (#47458 — a
      restart-avoiding design choice, see
      `reference_ollama_local_rewrite_decoupling.md` for the "decoupling, not a
      version workaround" pattern).
   4. **Prefer the tracking issue's own stated verification** (e.g. "remove X,
      run E2E `agent-create-no-restart.spec.ts`, confirm it stays green") over
      bundle archaeology. Bundle-reading can prove a workaround is STILL needed
      (mechanism present) but is weak evidence that one is safe to REMOVE —
      that needs the prescribed test. Memory: `reference_config_apply_rate_limit_drop.md`
      warns version guards can *become* bugs after an upstream fix, so this
      cuts both ways.

   If all four hold, remove the workaround in the same change with a test
   proving native behavior now covers it. Otherwise leave it and record why.

   **c. Features we built ourselves that OpenClaw now does natively.** Scan
   for "native", new config keys, or new built-in capabilities in areas where
   Pinchy has a bespoke plugin or workaround (e.g. transcript capture,
   session identity, memory, approvals — see `reference_pinchy_owned_transcript.md`,
   `reference_openclaw_approval_primitives.md`, `reference_mcp_native_credential_proxy.md`
   for precedent: MCP was migrated from a Pinchy-built plugin to native
   `mcp.servers` + a thin credential proxy once OpenClaw grew native support).
   **Same feature name ≠ same scope — check whether the native capability
   covers the REASON we built the bespoke version, not just its surface.**
   Real example: 2026.6.10 added a native "session-transcript SDK" (read,
   append, publish, lock), which sounds like it could replace `pinchy-transcript`.
   But its methods are all keyed by `{ agentId, sessionKey, sessionId }` —
   **session-scoped**. Pinchy owns `channel_messages` precisely because it
   needs a *channel-lifetime* record that survives `/new`/reset/compaction
   (per PR #553 / `reference_pinchy_owned_transcript.md`); adopting the
   session-scoped SDK would reintroduce the exact blank-on-`/new` bug it fixed.
   So: not adoptable. If a native capability genuinely covers the reason,
   flag it as a follow-up simplification; if it only matches the name, record
   why it doesn't fit so the next bump doesn't re-litigate it.

   **d. New OpenClaw features worth exposing in Pinchy.** Anything new that
   fits Pinchy's enterprise-governance angle (permissions, audit, channels,
   models) or that Pinchy's target audience (self-hosted enterprise teams,
   see "Product Context" in `AGENTS.md`) would plausibly want surfaced in the
   UI/API. Note these separately as feature ideas — they are out of scope
   for the bump itself, not blockers.

3. **Summarize findings against the four questions before touching code.**
   If (a) is empty, treat the bump as safe to proceed. If (a) is non-empty,
   flag it to the user before proceeding — don't silently absorb a breaking
   change into a routine bump. (b), (c), and (d) don't block the bump, but
   report them: (b) as follow-up cleanup candidates (ideally done alongside
   the bump if small), (c)/(d) as things worth a tracked issue or a
   `spawn_task`-style follow-up rather than silently doing nothing with them.

4. **Bump both pinned locations** to the same target version:
   - `packages/web/package.json` → `dependencies.openclaw`
   - `Dockerfile.openclaw` → the `npm install -g openclaw@...` line

5. **Check `openclaw-node`** (`packages/web/package.json` →
   `dependencies["openclaw-node"]`, our own client library in
   `~/projects/openclaw-node/`) for a matching newer release too —
   `npm view openclaw-node version`. If it needs a bump and we own it, bump
   and release it via `pnpm release X.Y.Z` in that repo first, not a manual
   `gh release create`.

6. **Install and verify:**
   ```bash
   pnpm install
   pnpm -C packages/web vitest run src/__tests__/lib/openclaw-version-pin-drift.test.ts
   pnpm test
   pnpm build
   ```

7. **Don't commit automatically.** Report the diff (`git status --short`,
   `git diff --stat`) and let the user decide to commit/PR — this touches a
   runtime dependency, not just app code.

## If a release note flags something sensitive

Don't just bump anyway. Options, in order of preference:
- Pin to the last version before the risky change and note why in a commit
  message / to the user.
- Do the bump on a branch, add/adjust a regression test for the specific
  behavior the release note describes, then bump.
- Ask the user whether to proceed if the tradeoff isn't yours to make alone.
