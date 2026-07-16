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
