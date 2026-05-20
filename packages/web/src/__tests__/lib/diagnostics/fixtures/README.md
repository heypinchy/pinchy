# Diagnostics test fixtures

## What lives here

This directory holds **sanitized, real-world OpenClaw session logs** used as
input for the diagnostics-export test suite. Treat these files as
representative samples of what Pinchy's diagnostics pipeline ingests in
production.

The fixture in this folder was sliced from a real OpenClaw conversation between
a user named "Clemens" and the Smithers (Tester) agent on 2026-05-19, then
sanitized:

- User name `Clemens` → `User`
- Workspace UUID `d36987ff-...` → `agt_FIXTURE_AGENT_0000000000000000000000`
- A second workspace UUID `17fa3b37-...` (referenced in a tool result) →
  `agt_FIXTURE_AGENT_OTHER_00000000000000000`
- Session UUID `10fbdbb5-...` → `ses_FIXTURE_SESSION_0001`
- User id suffix `nudpymfhb4fxkabouawotpburcdxlsif` → `usr_FIXTURE_TENANT_USER`
- Workspace paths `/root/.openclaw/workspaces/<agent>` → `/workspace/<agentId>`
- Other `/root/.openclaw/...` paths → `$OPENCLAW_STATE_DIR/...`
- Per-turn `traceId` and `runId` → stable `trace_FIXTURE_TURN_NN` /
  `run_FIXTURE_TURN_NN`
- German user prompts → English placeholders (e.g. "List the files in my
  workspace.")
- German assistant text → short English placeholders
- Long thinking blocks → `[fixture] reasoning trace redacted`
- Large `tool result` bodies → `[fixture] tool result body redacted`
- The 40+ KB `systemPrompt` block in `context.compiled` / `prompt.submitted` →
  a short structural stub that still carries the recognizable section headings
  (Tooling / Workspace / Project Context / Current user)
- The `tools` array of full JSON-schema bodies in `context.compiled` →
  a short marker `[{ "name": "...", "_fixture": "schema redacted" }]`

The structural shape of every event is intact — only string contents were
trimmed or substituted. Schema-level tests can rely on field names, types,
and the seven event types being correct.

## On-disk path on a Pinchy host

OpenClaw writes one trajectory file per _session_ (= one conversation key,
shared across user turns) at:

```
~/.openclaw/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl
```

Inside the Pinchy/OpenClaw container that is mounted as the OpenClaw state
volume, usually under `$OPENCLAW_STATE_DIR` (`/root/.openclaw` by default).

> **Note:** an older draft of the diagnostics plan said the path was
> `/openclaw-config/sessions/`. That was wrong — `openclaw-config` is the
> _config_ volume, sessions live under the _state_ volume's
> `agents/<agentId>/sessions/` subtree.

A _second_ JSONL file exists alongside it:

```
~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
```

That is OpenClaw's session-replay log (raw streaming chunks, `message` /
`custom` / `session` / `model_change` events). The diagnostics pipeline
**should not** read that file — its schema is less structured and it lacks
the rolled-up diagnostic fields. Always read the `.trajectory.jsonl`
sibling.

## File: `sample-session.trajectory.jsonl`

- **35 events** = 5 user turns x 7 events per turn.
- All five turns share `sessionId = ses_FIXTURE_SESSION_0001` (because
  OpenClaw groups every user-message-driven run for one conversation under
  one session) but each turn has its own `runId` and `traceId`.

| Turn | `runId`               | Prompt (placeholder)                              | Status    | `aborted` | `timedOut` | `usage`    | Tool calls in snapshot |
| ---- | --------------------- | ------------------------------------------------- | --------- | --------- | ---------- | ---------- | ---------------------- |
| 01   | `run_FIXTURE_TURN_01` | "What does pinchy_ls report for my uploads…"      | success   | false     | false      | 40692/2902 | 2 x pinchy_ls          |
| 02   | `run_FIXTURE_TURN_02` | "List the files in my workspace."                 | success   | false     | false      | 13593/1472 | 2 x pinchy_ls          |
| 03   | `run_FIXTURE_TURN_03` | "Show me the contents of IDENTITY.md."            | success   | false     | false      | 13690/1520 | 0 (synthesized)        |
| 05   | `run_FIXTURE_TURN_05` | "What do you see in this image? [image attached]" | **error** | true      | true       | null       | 2 x pinchy_ls          |
| 11   | `run_FIXTURE_TURN_11` | "What do you see in this image? [image attached]" | success   | false     | false      | 18117/222  | 2 x pinchy_ls          |

**Turn 03** has its `messagesSnapshot` truncated to drop the tool-using
assistant messages and toolResults, leaving only `user -> final assistant
(stopReason=stop, text only)`. This gives downstream code one
`model.completed` event with zero tool calls so test cases for the
"no tool calls this turn" branch can use the same fixture.

**Turn 05** is the timed-out / aborted case: `data.usage` is `null`,
`data.aborted = true`, `data.timedOut = true`, the snapshot ends with a
pending `user` message (no successful assistant reply).

## The seven event types

Every line in this fixture is one of these. Each event carries the same
**top-level envelope**:

```jsonc
{
  "traceSchema": "openclaw-trajectory",
  "schemaVersion": 1,
  "traceId": "trace_FIXTURE_TURN_01",
  "source": "runtime",
  "type": "...", // one of the seven below
  "ts": "2026-05-19T12:00:51.745Z",
  "seq": 1, // 1..7 within a turn
  "sourceSeq": 1,
  "sessionId": "ses_FIXTURE_SESSION_0001",
  "sessionKey": "agent:<agentId>:direct:<userId>",
  "runId": "run_FIXTURE_TURN_01",
  "workspaceDir": "/workspace/<agentId>",
  "provider": "ollama-cloud",
  "modelId": "qwen3-next:80b",
  "modelApi": "openai-completions",
  "data": {
    /* event-specific payload */
  },
}
```

Pin diagnostics readers to `traceSchema === "openclaw-trajectory" &&
schemaVersion === 1`. If either ever changes, fail loudly rather than parse
optimistically.

| `type`             | `data.*` fields of interest                                                                                                                                                                                                                                                                                                                                                                                            | Notes                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`  | `trigger`, `sessionFile`, `workspaceDir`, `agentId`, `messageProvider`, `messageChannel`, `toolCount`, `clientToolCount`                                                                                                                                                                                                                                                                                               | Always `seq=1`. `sessionFile` is the absolute path to the _other_ JSONL (session-replay), not this trajectory file.                                                                                        |
| `trace.metadata`   | `capturedAt`, `harness.{type,name,version,gitSha,os,runtime,invocation,entrypoint,workspaceDir,sessionFile}`, `model.{provider,name,api,fastMode,thinkLevel,reasoningLevel}`, `plugins`, `prompting.{skillsPrompt,systemPromptReport}`, `redaction`, `metadata.{sessionKey,agentId,messageProvider,messageChannel}`, `config`                                                                                          | The big one. `harness.version` is the OpenClaw release. `redaction.*` flags tell you what _the trace itself_ already scrubbed (config secrets, image data, local paths). `seq=2`.                          |
| `context.compiled` | `systemPrompt` (string, ~18 KB in real logs), `tools` (array of full tool schemas), `messages` (history fed to the model this turn), `prompt`, `imagesCount`, `streamStrategy`, `transport`, `transcriptLeafId`                                                                                                                                                                                                        | This is the **pre-call** context — what was about to be sent to the provider. `seq=3`.                                                                                                                     |
| `prompt.submitted` | `prompt`, `systemPrompt`, `messages`, `imagesCount`                                                                                                                                                                                                                                                                                                                                                                    | Effectively a copy of the request the provider received. `seq=4`.                                                                                                                                          |
| `model.completed`  | See expanded table below.                                                                                                                                                                                                                                                                                                                                                                                              | **This is the main source of truth for diagnostics.** `seq=5`.                                                                                                                                             |
| `trace.artifacts`  | `capturedAt`, `finalStatus`, `aborted`, `externalAbort`, `timedOut`, `idleTimedOut`, `timedOutDuringCompaction`, `timedOutDuringToolExecution`, `usage`, `promptCache`, `compactionCount`, `assistantTexts`, `finalPromptText`, `promptErrorSource`, `toolMetas`, `itemLifecycle`, `didSendViaMessagingTool`, `messagingToolSentTargets`, `messagingToolSentTexts`, `messagingToolSentMediaUrls`, `successfulCronAdds` | Mostly a superset / restatement of `model.completed.data` plus messaging-tool side-effect summaries. Use this for "did the agent ultimately send a message via the message tool?" type questions. `seq=6`. |
| `session.ended`    | `status` (`"success"`/`"error"`), `aborted`, `externalAbort`, `timedOut`, `idleTimedOut`, `timedOutDuringCompaction`, `timedOutDuringToolExecution`                                                                                                                                                                                                                                                                    | The tombstone. Always `seq=7`. Use to know the turn is closed; nothing else for this `runId` will follow.                                                                                                  |

### `model.completed.data` field reference

This is the diagnostics payload. The fixture exercises every field below.

| `data.<field>`                 | Type                                            | Purpose / how diagnostics should read it                                                                                                                                          |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage`                        | `{input, output, total} \| null`                | Token counts for the **whole turn** (sum across provider calls). `null` if the turn errored before completing a request. Use for cost dashboards.                                 |
| `promptCache.lastCallUsage`    | `{input, output, cacheRead, cacheWrite, total}` | Cache breakdown of the _most recent_ provider call within this turn. Anthropic-style prompt caching exposes both read and write counts. Useful for "cache hit ratio" diagnostics. |
| `promptCache.lastCacheTouchAt` | `number` (ms epoch)                             | When the cache was last touched. Lets you detect "cache went cold" patterns.                                                                                                      |
| `compactionCount`              | `number`                                        | How many compactions happened this turn. >0 means context was rolled forward.                                                                                                     |
| `aborted`                      | `boolean`                                       | The turn ended without a final assistant reply.                                                                                                                                   |
| `externalAbort`                | `boolean`                                       | The abort was initiated from outside (e.g. user clicked stop).                                                                                                                    |
| `timedOut`                     | `boolean`                                       | The turn hit the per-turn deadline.                                                                                                                                               |
| `idleTimedOut`                 | `boolean`                                       | The provider went idle past the idle deadline.                                                                                                                                    |
| `timedOutDuringCompaction`     | `boolean`                                       | The timeout fired while running a compaction step (not a provider call).                                                                                                          |
| `timedOutDuringToolExecution`  | `boolean`                                       | The timeout fired while a plugin tool was running.                                                                                                                                |
| `promptErrorSource`            | `string \| null`                                | When non-null, names which subsystem raised the failure (provider, tool, etc.).                                                                                                   |
| `finalPromptText`              | `string`                                        | The user message that opened this turn — useful for diagnostics that need a one-line "what was asked".                                                                            |
| `assistantTexts`               | `string[]`                                      | The plain-text assistant utterances produced this turn (post-tool-loop). Empty for aborted turns.                                                                                 |
| `messagesSnapshot`             | `Message[]`                                     | **The full message history at the moment the turn ended.** See per-message field table below.                                                                                     |

### `messagesSnapshot[N]` per-message fields

Each element of `messagesSnapshot` is a message in the conversation transcript
as the model saw it after this turn. Diagnostics that need the
`finish_reason` equivalent live here, not at the event top level.

| Field        | Type                                                                                                                    | Notes                                                                                                                                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`       | `"user" \| "assistant" \| "toolResult"`                                                                                 | `toolResult` is OpenClaw's term for what OpenAI/Anthropic call `tool` role messages.                                                                                                                                                                                                          |
| `content`    | array of `{type, ...}` parts                                                                                            | `type` can be `"text"`, `"thinking"`, `"toolCall"`, `"image"`. See below.                                                                                                                                                                                                                     |
| `stopReason` | `"stop" \| "toolUse" \| null`                                                                                           | **This is the `finish_reason` equivalent.** Only set on `assistant` messages produced by the model. `"toolUse"` means the model stopped to call a tool; `"stop"` means the model ended its turn with a plain text reply. `null` for non-assistant rows or for the aborted turn's final state. |
| `usage`      | `{input, output, cacheRead, cacheWrite, totalTokens, cost: {input, output, cacheRead, cacheWrite, total}} \| undefined` | Per-message token + cost breakdown. Only present on assistant messages. Sum across the snapshot's assistant messages = the turn-level `data.usage.total`.                                                                                                                                     |
| `model`      | `string \| undefined`                                                                                                   | The model id that produced this specific assistant message (allows model changes within a turn).                                                                                                                                                                                              |
| `provider`   | `string \| undefined`                                                                                                   | Provider id for this message.                                                                                                                                                                                                                                                                 |
| `api`        | `string \| undefined`                                                                                                   | API protocol family (`openai-completions`, etc.).                                                                                                                                                                                                                                             |
| `responseId` | `string \| undefined`                                                                                                   | Provider response id; useful for cross-referencing provider-side logs.                                                                                                                                                                                                                        |
| `timestamp`  | `number` (ms epoch)                                                                                                     | When this message was finalized.                                                                                                                                                                                                                                                              |

`content[]` parts:

- `{ type: "text", text: string }` — plain text body.
- `{ type: "thinking", thinking: string, thinkingSignature?: string }` —
  reasoning/scratchpad output from thinking-mode models. In this fixture
  every `thinking` body is replaced with `"[fixture] reasoning trace redacted"`.
- `{ type: "toolCall", id, name, arguments: object }` — a tool invocation
  emitted by the assistant. `name` is the registered tool id (e.g. `pinchy_ls`).
- `{ type: "image", ... }` — present on `user` messages when the user
  attached an image.

For `role: "toolResult"`, the content carries the tool's serialized output —
in this fixture, replaced by `"[fixture] tool result body redacted"`.

## Surprises / notes

- The trace's own schema name is `openclaw-trajectory`, version 1. Pin a
  parser to that pair and reject anything else.
- **There is no top-level `finish_reason` field** anywhere in the trajectory
  log. The equivalent lives at
  `model.completed.data.messagesSnapshot[N].stopReason` on the latest
  `assistant` message produced this turn.
- **There is no top-level `model` field on `model.completed.data`** — the
  per-turn model lives on the envelope (`event.modelId`, `event.provider`,
  `event.modelApi`), and the per-assistant-message model lives on
  `messagesSnapshot[N].model`.
- OpenClaw writes **two JSONL files per session**:
  - `<sessionId>.jsonl` — session-replay log (raw streaming chunks, custom
    events). Lower-level, less structured.
  - `<sessionId>.trajectory.jsonl` — the file this fixture is sliced from.
    Higher-level, diagnostics-shaped.
    Diagnostics should always read the `.trajectory.jsonl` file. Do not depend
    on the session-replay format.
- The `sessionId` is per-conversation, not per-turn. Every user message in a
  conversation reuses the same `sessionId` but starts a new `runId` (and
  `traceId`). All 5 turns in this fixture share one `sessionId`.
- Inside one `runId`, `seq` runs 1..7 in event-type order
  (`session.started` -> `trace.metadata` -> `context.compiled` ->
  `prompt.submitted` -> `model.completed` -> `trace.artifacts` ->
  `session.ended`). If your reader sees a sequence break, treat the run as
  truncated.
- The same `runId` _can_ appear twice if a turn was retried after a
  timeout — the source log we sliced from had this for the
  `run_FIXTURE_TURN_05` turn. The fixture keeps only the first of the two
  attempts; downstream code should be ready to encounter the duplicate in
  the wild and prefer the latest by `ts`.
- `data.usage` is `null` for aborted/timed-out turns. Diagnostics that
  aggregate token usage must treat `null` as "no data this turn" and not
  zero, otherwise denominators get wrong.
- `assistantTexts` is `[]` (not `null`) for aborted turns.
- The `harness.invocation`, `harness.workspaceDir`, and `harness.sessionFile`
  fields can contain absolute host paths in the wild. OpenClaw's own
  redaction (`data.redaction.harness.localPathsRedacted = true` on real
  logs) replaces them; this fixture leaves the structure intact under
  `$OPENCLAW_STATE_DIR/...` placeholders.
