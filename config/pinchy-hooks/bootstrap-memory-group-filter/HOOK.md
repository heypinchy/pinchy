---
name: bootstrap-memory-group-filter
description: "Strip MEMORY.md from bootstrap for channel group sessions so a shared agent's per-user memory is never pushed into a group."
homepage: https://github.com/heypinchy/pinchy/issues/369
metadata:
  {
    "openclaw":
      {
        "emoji": "🦞",
        "events": ["agent:bootstrap"],
      },
  }
---

# Bootstrap Memory Group Filter Hook

Pinchy-shipped `agent:bootstrap` hook. Removes `MEMORY.md` from the bootstrap
file set when the session is a channel **group** session
(`agent:<id>:<channel>:group:<peer>`), leaving DM, cron, and subagent sessions
untouched.

## Why

OpenClaw pushes workspace bootstrap files into every non-subagent/non-cron
session. A shared agent's `MEMORY.md` accumulates knowledge persisted from
individual users' private DM conversations, so injecting it into a group session
discloses one user's memory to everyone in the group. See
[heypinchy/pinchy#369](https://github.com/heypinchy/pinchy/issues/369).

## Relationship to the upstream fix

The durable fix belongs in OpenClaw core:
`filterBootstrapFilesForSession` already narrows the set for subagent and cron
sessions but not channel-group sessions —
[openclaw/openclaw#108881](https://github.com/openclaw/openclaw/issues/108881).
**Delete this hook once that upstream fix ships.**

## Scope

Stops the automatic per-message bootstrap push only. It does not stop a group
member from deliberately eliciting memory via the agent's `pinchy_read` /
`memory_search` tools — that residual belongs to the per-user-memory work.

## Activation

Loaded via `hooks.internal.load.extraDirs` pointing at `/opt/pinchy-hooks`,
emitted by Pinchy's `regenerateOpenClawConfig()`. No per-session configuration.

## Verification (deploy gate)

The unit tests (`config/__tests__/bootstrap-memory-group-filter.test.mjs`)
prove the filter logic, but they cannot prove OpenClaw actually **loads and
fires** this hook — that depends on the runtime event contract, which no unit
harness exercises. Treat the following as an explicit merge/deploy gate on any
deploy that ships this hook or bumps OpenClaw:

1. **Registration** — after the gateway starts, confirm the hook loaded without
   error (no parse/registration error in the OpenClaw logs for
   `bootstrap-memory-group-filter`).
2. **Contract intact** — grep the gateway logs for
   `[bootstrap-memory-group-filter]`. This handler fails **loud, not open**: it
   only warns when an `agent:bootstrap` event lacks `bootstrapFiles[]` or a
   string `sessionKey`. Any such warning means OpenClaw changed the event
   contract and the filter is no longer running — investigate before trusting
   the mitigation.
3. **Behaviour** — in a Telegram **group** session against a shared agent whose
   `MEMORY.md` is non-empty, confirm the bootstrap set delivered to that session
   contains no `MEMORY.md`, while a **DM** session with the same agent still
   receives it.

Because the mitigation fails open if the contract silently changes, the
`update-openclaw` skill lists this hook's contract as a runtime dependency to
re-verify on every OpenClaw bump.
