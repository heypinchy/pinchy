# Agent permissions: cut by zone, not by tool

Design record, 2026-08-05. Supersedes the fix proposed in #755.

## The problem

Three symptoms, one root cause.

**Memory is a side effect of a file-write checkbox.** `build.ts` puts `MEMORY.md` +
`memory/` into an agent's paths only `if (allowedTools.includes("pinchy_write"))`.
No agent template grants `pinchy_write`; the New-Agent form injects it into every
creation instead. So whether an agent can remember anything is decided by a React
form, and unticking a box labelled "Write files" silently removes the agent's
memory. `createSmithersAgent` never gets the injection, so **every personal agent
is memory-less** — the agent the docs call the user's personal notebook.

**The tool list tells a memory-less agent it has memory.** `computeAllowedTools()`
emits `memory_search`/`memory_get` unconditionally, and OpenClaw's `memory-core`
adds a `## Memory Recall` prompt section whenever those tools are present
(`buildPromptSection`, `dist/extensions/memory-core/index.js`) instructing the
agent to search memory before answering. Agent, tools and prompt all assert a
capability the data does not back. That is the production behaviour reported in
#755.

**The permission UI describes something that does not exist.** "Write files —
Write files into the agent's workspace (uploads directory)" sits under the
**Knowledge Base** heading. Three claims, three problems: it is the master switch
for memory (unstated), it writes `workbench/` and not just `uploads/` (stale
since #418), and it has nothing to do with the knowledge base — mounted `/data`
volumes are structurally read-only, because `write_paths` is built without them.

## The decision

Cut permissions by **zone** — who owns the data — and not by **operation** or by
tool. This is the axis every comparable system uses: Google Drive's `drive.file`
scopes to files the app created or the user picked; Android scoped storage gives
an app its own directory freely and gates shared storage; Cursor's agent sandbox
is read/write inside the workspace and read-only outside; the OAuth convention is
`resource.action` with a coarse read/write, never `create` beside `update`.

| Zone           | Path                                             | Owner                  | Access                        |
| -------------- | ------------------------------------------------ | ---------------------- | ----------------------------- |
| Memory         | `MEMORY.md`, `memory/`                           | the agent's own recall | grant `pinchy_memory`         |
| Workbench      | `workbench/`                                     | the agent's own drawer | grant `pinchy_write`          |
| Uploads        | `uploads/`                                       | **the user**           | read always, write never      |
| Knowledge base | `/data/**`                                       | the organization       | read via the directory picker |
| Identity       | `SOUL.md`, `AGENTS.md`, `IDENTITY.md`, `USER.md` | the platform           | never writable                |

Two consequences worth stating, because both were considered and rejected as
separate permissions:

- **`pinchy_write` and `pinchy_generate_file` stay one grant.** They differ in
  mechanism (arbitrary text at a path vs. a table rendered to CSV/XLSX/PDF), not
  in zone — both write the agent's own drawer. Splitting them was the first
  proposal and it failed the only test that matters: nobody can explain to an
  operator why "may produce a spreadsheet" and "may write a file" are two
  decisions. `pinchy_generate_file` remains implicit, gated on `workbench` being
  in `write_paths`, as today.
- **`uploads/` leaves `write_paths`.** It is the user's zone. The rest of the
  codebase already treats it that way — `pinchy_generate_file` deliberately
  targets `workbench` only, and `pinchy-email` writes attachments with
  `flag: "wx"` under the comment "uploads/ is also the user's". `pinchy_write`
  with `overwrite: true` is the only path in the system that can replace a file
  the user uploaded.

## Permission model

Memory is a grant that owns no tool. That is not a new special form:
`TOOL_REGISTRY` is already the _grant_ model rather than the runtime tool list —
`pinchy_ls` and `pinchy_read` are asserted **out** of it by test, because they are
implicit. `pinchy_memory` is the same mechanism seen from the other side: an entry
that resolves to paths instead of to a tool name. `computeAllowedTools()` keeps
deriving `tools.allow` from the plugin manifests, so `pinchy_memory` can never
leak into the emitted allowlist.

Settings UI:

- **Memory** (own section) — "Remember information across conversations and look
  it up later."
- **Workspace → Create files** — "Create files in its workspace and share them
  with you as downloads."
- **Knowledge Base** — the directory picker, with an explicit note that agents can
  only read these directories.

Two checkboxes and a picker, against today's one misleading checkbox in the wrong
section.

## Defaults: the template is the decision

Pinchy's default is that nothing is on. A curated template, however, _is_ a
decision someone already made — so templates are generous and a from-scratch agent
starts empty. The existing mechanism carries this with no new machinery: "Custom
Agent — Start from scratch" is itself a template with `allowedTools: []`.

- Every curated template gains `pinchy_memory` **and** `pinchy_write`. Granting
  both avoids a regression: every UI-created agent has file write today, and
  removing it from analyst templates would silently take away
  `pinchy_generate_file` — the XLSX/PDF export delivered as a chat download.
- `custom` keeps `allowedTools: []`.
- `createSmithersAgent` gains `pinchy_memory`. Personal agents are not templates
  but they are curated, and memory is the whole point of a personal assistant.
- **`defaultAllowedTools: ["pinchy_write"]` is removed from `new-agent-form.tsx`.**
  Permissions belong to the template, not to a React form. `createAgent`'s
  `defaultAllowedTools` parameter stays — it is part of the API contract — but the
  first-party UI stops using it.

The behaviour change to accept knowingly: **a new Custom agent can write nothing
until someone ticks a box.** That is the philosophy applied honestly.

## Emitting the config

`build.ts`, per agent:

```
allowed_paths = [...adminPaths, uploads, workbench]
              + [MEMORY.md, memory/]   if pinchy_memory
write_paths   = [workbench]            if pinchy_write
              + [MEMORY.md, memory/]   if pinchy_memory
```

`write_paths` is emitted whenever **either** grant is present, which is what makes
option A work: `pinchy-files` registers `pinchy_write` off the presence of
`write_paths`, so an agent with memory-only gets a write tool scoped to its memory
and nothing else. The tool description enumerates its writable paths, so the agent
sees the truth rather than being told a story about it. `MEMORY.md` stays granted
as a **file**, never as the workspace root — the trailing-slash boundary in
`validate.ts` is what keeps `SOUL.md` and its siblings unwritable.

`memory_search` / `memory_get` become **conditional on `pinchy_memory`**.
`agentEntry.tools.allow` is already emitted per agent, so this is a signature
change on `computeAllowedTools()` and nothing structural. This closes the open
acceptance criterion in #755 and, more importantly, silences `memory-core`'s own
`## Memory Recall` prompt for agents that have no memory — the prompt is keyed on
those tools being present.

`memory-prompt.ts` gates on `pinchy_memory` instead of `pinchy_write`.

An agent whose memory grant is removed keeps its files on disk but can no longer
reach them: the paths leave both lists. That is the correct reading of a toggle —
revoking access, not destroying data.

## Migration

One migration, three rules, in this order:

1. Every agent with `pinchy_write` gains `pinchy_memory`. **Not optional** — these
   agents have memory today and may have written to it; without this they would
   lose access to existing data.
2. Every agent whose `template_id` is set and is not `custom` gains
   `pinchy_memory`. This applies the new template policy retroactively and is what
   repairs the reported production case.
3. Every `is_personal` agent gains `pinchy_memory` (Smithers has no `template_id`).

No new audit event type. A one-off migration does not earn a permanent entry in
the event catalogue — it would pull in the docs-coverage guard and the audit-trail
reference for something that happens once. The migration file and the upgrade note
are the record.

Upgrade notes must state both changes: agents gain memory, and `uploads/` becomes
read-only for `pinchy_write` (a custom `AGENTS.md` that instructs an agent to write
there needs to point at `workbench/`).

## Tests

TDD, failing test first. The load-bearing ones:

- An agent with **only** `pinchy_memory` can write and read back a memory file.
- An agent with **only** `pinchy_memory` cannot write `workbench/` or `uploads/`.
- An agent with **only** `pinchy_write` cannot write `MEMORY.md` or `memory/`.
- No agent can write `SOUL.md` / `AGENTS.md` / `IDENTITY.md` / `USER.md`
  (regression guard on the file-vs-directory boundary).
- `uploads/` is not in `write_paths` for any grant combination.
- `memory_search`/`memory_get` appear in `tools.allow` only with `pinchy_memory`.
- `pinchy_generate_file` still registers for a `pinchy_write` agent (it is gated on
  `workbench` in `write_paths`, so the emission change must not break it).
- Migration: the three rules, plus a Custom-template agent that gains nothing.
- Every curated template carries both grants; `custom` carries neither.

## Docs

`agent-permissions.mdx` needs `pinchy_memory` (the docs-coverage guard unions
registry ids with manifest tools and will fail until it is documented).
`agent-memory.mdx` currently claims memory is universal and lists three untracked
promises. `instructions-vs-memory.mdx` names "auto-memory" twice as a mechanism
that does not exist here — OpenClaw's native pre-compaction flush is disabled in
`build.ts` and `active-memory` is not enabled, so the only mechanism is the agent
following the memory prompt. The page contradicts itself on this one line later.

## Out of scope — file as issues

1. **`pinchy_write --overwrite` can swap the bytes under an existing download
   grant.** The grant is `(agentId, filename, userId)` with no content hash and the
   file is read at serve time, which is exactly why `pinchy_generate_file` refuses
   to overwrite. On a shared agent, overwriting a delivered `workbench` filename in
   user B's turn changes what user A's existing chip serves. Security.
2. **Memory inspection and deletion.** Promised in `agent-memory.mdx`, tracked
   nowhere, EU-AI-Act relevant. The per-agent toggle is delivered by this design;
   these two are not.
3. **Upstream OpenClaw:** `MEMORY_FLUSH_ALLOWED_TOOL_NAMES` is a hardcoded
   `Set(["read", "write"])` filtered over the assembled tool list, so a platform
   that denies the native fs tools cannot use the pre-compaction memory flush at
   all. OpenClaw already makes the flush _plan_ pluggable via
   `registerMemoryCapability({ flushPlanResolver })`; the tool list should follow.
4. **Evaluate `active-memory`** once memory is a real permission. It runs a
   blocking recall sub-agent before every reply and injects hidden context — worth
   it for conversational agents, but it needs to be visible in Diagnostics before
   it belongs in a governance product.
