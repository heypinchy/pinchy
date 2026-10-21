# Blocking budgets inside the OpenClaw runtime

Design record, 2026-10-19. Follows `2026-10-16-cost-governance-design.md` (#36).

## The problem

A blocking budget (#36) stopped an agent only at Pinchy's own doors: the browser
chat WebSocket (`client-router.ts`) and the email-workflow loader. Telegram
messages go from the bot straight into OpenClaw and were never stopped — the
cost-governance guide had to say so. Every future channel would have had the
same hole, because each one needs its own door.

The fix is one gate where every run passes through: OpenClaw's
`before_agent_run` plugin hook.

## What OpenClaw does with a block (verified against 2026.7.1-2)

Read in `dist/hook-runner-global-*.js` and `dist/selection-*.js`, and in
`docs/plugins/hooks.md`:

- `before_agent_run` fires after prompt construction and **before any model
  input**, for every run of an agent regardless of channel. A block costs no
  tokens.
- A handler returning `{ outcome: "block", reason, message?, category? }` stops
  the run. OpenClaw replaces the user's message in the session with
  `Your message could not be sent: <message> (blocked by <pluginId>)` and
  returns it as the run's (error) reply payload — on Telegram, the sender gets
  that text as the bot's answer. The E2E (`e2e/telegram/budget-block.spec.ts`)
  asserts exactly this.
- **Returning `undefined` is a block**, not a pass (`mergeNullResults`), despite
  the `| void` in the type. The handler must return `{ outcome: "pass" }`.
- A thrown error and the hook timeout (15 s default) are also blocks:
  `before_agent_run` is **fail-closed** in the runtime.
- It is a _conversation hook_: a non-bundled plugin is silently skipped (one
  warn diagnostic, no error) unless `plugins.entries.<id>.hooks.allowConversationAccess`
  is `true`. Pinchy's config generator writes that for `pinchy-audit`.

## Decision: fail open, unless the last answer was a block

When Pinchy cannot be asked (restart, deploy, network fault, 5xx, a rejected
token), the gate **passes** — unless the last answer it got for that agent was a
block, in which case it keeps blocking.

Why not fail closed: the hook runs for every run of every agent on the instance,
including the ones with no budget at all. Failing closed turns every Pinchy
restart into "Your message could not be sent" on every channel — an outage
caused by the cost control, on instances that never set a budget. The cost of
failing open is bounded: a budget is monthly, the turn that crosses the line has
already finished before any check can see it (spend is recorded after a turn),
and every turn that slips through during an outage is still recorded and still
counts.

Why not fail open unconditionally: an agent that was blocked a second ago is
still over its budget. "Pinchy is restarting" is not new information about the
budget, so the last known answer stands.

The runtime's own fail-closed policy is never reached: the handler catches its
own errors and bounds its own fetch (3 s, below the 15 s hook timeout).

After a failed check the gate answers from what it knows for 10 s before it asks
again, and warns once per outage: during one, every run of every agent would
otherwise pay the 3 s timeout and write a log line. A definitive rejection (a
4xx such as a rotated gateway token) is logged as "blocking budgets are not
enforced", because it does not heal on its own.

The last answer lives in the plugin's memory. It survives a Pinchy restart, but
not an OpenClaw restart or a re-run of `register()`: when both containers
restart together, paused agents answer until Pinchy is up. Persisting it would
need storage on the OpenClaw side for one bounded window, so the guide says so
instead.

The fields beside `agentId` are audit detail only, so the route drops a
malformed one rather than answering 400 — a 400 reads as "unreachable" here and
would switch the budget off for every run. For the same reason the lookups that
only shape the audit row (agent name, actor) fall back instead of throwing.

## Shape

- `POST /api/internal/budgets/check` (gateway token): `{ agentId, sessionKey?,
channel?, senderId?, trigger? }` → `{ blocked: false }` or `{ blocked: true,
message }`. On a block it writes `chat.policy_refused` with
  `reason: "budget_exhausted"` and the channel. POST, not GET, because a refusal
  writes an audit row.
- `pinchy-audit` registers `before_agent_run`. A _pass_ is cached per agent for
  15 s, so a busy agent asks Pinchy at most four times a minute. A _block_ is
  never served from cache while Pinchy answers, so every refused turn is audited
  and an admin raising the budget takes effect on the next message.
- The user-facing sentence lives in Pinchy (`budgetExhaustedMessage`) and is the
  same in the browser and on Telegram.
- The browser door in `client-router.ts` stays: it refuses before a run exists
  and shows the message in the chat UI rather than as a failed run.
- Inbox workflows: the loader skips a paused workflow when a batch starts, but a
  budget crossed mid-batch is refused by the gate. The run adapter asks the
  budget before each run and again after a failed one, and defers
  (`RunDeferredError`) instead of finalizing the email `failed` — a budget
  pauses a workflow, it does not break it.

## Not throttled

Each refusal is one inbound message from a sender who already passed the
channel's own access control (a paired Telegram account), the same as a browser
refusal, which is not throttled either. The bound AGENTS.md asks for applies to
rows an _anonymous_ caller can mint.

## Known limit: a message steered into a turn that is then blocked

Found by the first CI run of the Telegram E2E. A second message that arrives
while a turn is still being prepared is _steered_ into that turn, and OpenClaw
waits for it to appear in the transcript (`DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS`,
120 s). When `before_agent_run` then blocks the turn, the steered message is
never committed, so the turn — and the refusal reply — is held for the full
120 s, and later messages in that session queue behind it.

The window is the time between a run starting and the gate answering: usually
milliseconds, a few seconds on a loaded host. It does not lift the block — the
refusal still arrives, late. It is OpenClaw's behaviour (block × steering), not
something the hook can avoid, so it belongs upstream rather than in a
workaround here. The E2E sends a new message only after the previous turn
answered, which keeps it out of the window.
