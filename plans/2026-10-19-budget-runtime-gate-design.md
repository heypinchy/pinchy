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

## Not throttled

Each refusal is one inbound message from a sender who already passed the
channel's own access control (a paired Telegram account), the same as a browser
refusal, which is not throttled either. The bound AGENTS.md asks for applies to
rows an _anonymous_ caller can mint.
