# Cost governance: member policies and monthly budgets

Design record, 2026-10-16. Picks up #36 ("Cost Budgets per Agent").

## The problem

An instance sold at a flat monthly price with the LLM included has one
financial risk: people use it differently than the calculation assumed. A
knowledge-base deployment for ~30 users on Claude Haiku 5.5 costs a known amount.
The same instance turns expensive when members start chatting freely with their
personal Smithers, attach automations to it that run on every incoming email, or
when an admin moves an agent to a larger model (~20× the price).

Pinchy can see all of this today (the usage dashboard records every turn with a
USD estimate) but cannot do anything about it:

- **Every member gets a personal Smithers**, seeded on invite claim, and can chat
  with it without limit.
- **Every member may create email automations** on that Smithers
  (`canManageAgentWorkflows`): a standing, autonomous token consumer.
- **No budget exists anywhere.** #36 asks for one; #35, the stats infrastructure
  it waited on, has shipped.

Governance and cost control are what Pinchy sells, so this is product work, not
a one-off for one customer.

## Part 1 — Two member policies

Two instance-wide switches under **Settings → Organization → Member access**:

| Setting                                                | Key                             | Default |
| ------------------------------------------------------ | ------------------------------- | ------- |
| Members can use a personal agent (Smithers)            | `policy.member_personal_agents` | on      |
| Members can create automations on their personal agent | `policy.member_automations`     | on      |

Stored in the `settings` table as `"true"`/`"false"`. **An absent key reads as
on**, so an upgrade changes nothing until an admin decides otherwise.

They are **settings, not feature flags**: changed at runtime by an admin, audited
as `settings.updated` with a from/to diff, and enforced server-side.

**Not license-gated.** Both switches only ever take capability away. Gating them
would mean a community instance cannot protect itself, and a lapsed license could
not switch a restriction back off. Budgets (Part 2) are the Enterprise half.

### "Off" pauses and hides. It never deletes.

Turning a policy off must be reversible in one click, so no data is touched:

- **Personal agents off:** members' Smithers stay in the database with their
  chats, memory and files. Members no longer see or reach them. Turning the
  setting back on brings everything back exactly as it was.
- **Automations off:** existing member automations keep their `enabled` flag.
  The sweep stops running them while the policy is off, and they resume when it
  is turned back on. Mail that arrived in between is picked up within each
  automation's look-back window, the same way the sweep already recovers from
  downtime.

The alternative, disabling or deleting rows, was rejected: it turns a policy
toggle into a migration nobody can undo, and it silently loses work a member
built.

**Admins are not members.** Both policies apply to users with the `member` role.
An admin's own Smithers and its automations are unaffected, because admins are
the ones who set up the instance and need Smithers for onboarding and org
context. Promoting a member to admin restores their access.

**Turning automations off while personal agents stay on** keeps members chatting
with Smithers. **Turning personal agents off** also pauses those agents'
automations, since an automation runs as its agent.

### Where it is enforced

The rule lives in one pure predicate, `isPausedPersonalAgent(agent, ownerRole,
policy)` in `lib/instance-policy.ts`, and is consulted at every door a member's
personal agent has:

| Surface                    | Choke point                    | Answer when off                                                     |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| Sidebar, agent lists, `/`  | `getVisibleAgents`             | agent omitted                                                       |
| HTTP routes under an agent | `getAgentWithAccess`           | 403 `personal_agent_disabled` (owner only)                          |
| Chat pages                 | `loadChatPageAgent`            | redirect to `/agents`, which explains why                           |
| WebSocket chat             | `ClientRouter.handleMessage`   | `error` frame, code `policy_personal_agent_disabled`, not retryable |
| Telegram                   | allow store + routing bindings | member DMs no longer allowed or bound                               |
| Email automations          | `loadDispatchableWorkflows`    | workflow skipped (paused)                                           |

The 403 is not an existence oracle: only the owner reaches that branch, and they
already know their own agent exists. Everyone else still gets the byte-identical
404 that `getAgentWithAccess` documents.

**Telegram needs both halves.** The personal-agent bot routes each linked user's
DMs to _their own_ Smithers, and falls back to the bot owner's agent when the
user has none (`build.ts`). Removing only the binding would route a member into
the admin's private Smithers. So the binding is skipped **and** the member is
left out of that bot's allow store. Shared-agent bots are unaffected. Changing
the policy regenerates the OpenClaw config and recalculates the allow stores.

**Automations off** is enforced in three places:

- `POST /api/automations`: a member creating one on a personal agent gets 403,
  code `member_automations_disabled`.
- `PATCH /api/automations/[id]`: a member may still **disable** and **delete**,
  but not enable.
- The workflow loader skips the workflow. It is not reported as `unrunnable`,
  because that would mark it `error`, and nothing is wrong with it.

The generic `POST /api/settings` refuses `policy.*` keys. Without that refusal it
would write the value with a value-less audit row and skip the config
regeneration the Telegram half depends on.

### What members see

- **Sidebar:** no Smithers. The agents page explains that their admin has
  turned personal agents off. If they have no shared agents either, the empty
  state says so instead of inviting them to create one.
- **An open chat tab** that sends after the switch gets a plain, non-retryable
  message, not a Retry button that cannot succeed. Codes prefixed `policy_` are
  rendered that way on the client.
- **Automations tab** (personal agents on, automations off): a notice that new
  automations are off and existing ones are paused. The create button is
  disabled; disable and delete still work.

`GET /api/settings/governance` is readable by any signed-in user so the UI can
explain itself. The values are not secret. `PUT` is admin-only.

## Part 2 — Monthly cost budgets (first slice of #36)

### What exists

- `usage_records` has one row per completed turn with `estimated_cost_usd`
  computed at insert time. Web chat rows land within about a second of the turn.
  Telegram, cron and inbox rows land on the next 60-second poller sweep.
- The `(agent_id, timestamp)` index serves "agent X since date D".
- There is no reusable spend query and no admin notification channel with a
  reader. The `notifications` table is write-only today and needs an `agentId`.

### The slice

- **Two scopes:** one instance-wide budget, and at most one budget per agent.
- **One period:** the calendar month in the organization timezone
  (`org.timezone`). Weekly and custom periods from #36 wait until someone asks.
- **One unit:** USD, from `estimated_cost_usd`. Token budgets wait too, because
  the money is the question a flat price raises.
- **Warning at 80%**, fixed. A configurable threshold adds a field nobody has
  asked to tune.
- **At 100%, a configurable action** per budget:
  - `notify`: warn admins; everything keeps running.
  - `block`: refuse new web-chat turns for that agent (instance budget: every
    agent), and pause email automations, until the month rolls over or an admin
    raises or removes the budget.

### Storage

A new `cost_budgets` table, not settings keys, because a budget needs an
alert state that two processes must not fire twice:

```
cost_budgets
  id                  uuid pk
  agent_id            text null → agents.id ON DELETE CASCADE   (null = instance)
  monthly_limit_usd   numeric(12,2) not null, > 0
  on_exceeded         text not null  ('notify' | 'block')
  warned_period       text null      ('YYYY-MM' the 80% alert fired for)
  exceeded_period     text null      ('YYYY-MM' the 100% alert fired for)
  created_at, updated_at
  UNIQUE NULLS NOT DISTINCT (agent_id)   -- one instance budget, one per agent
```

### Spend and status

`getBudgetStatuses()` computes, in one query per scope, the sum of
`estimated_cost_usd` since the start of the current month in the org timezone
(`date_trunc('month', now() AT TIME ZONE tz) AT TIME ZONE tz`). Each status is
`ok`, `warning` (≥ 80%) or `exceeded` (≥ 100%).

### Alerts

`evaluateBudgetAlerts()` runs after each usage-poller sweep. For a budget that
crossed a line this month, it claims the alert with a conditional update
(`SET warned_period = $p WHERE id = $id AND warned_period IS DISTINCT FROM $p
RETURNING`), and only the claimant writes the audit row, so restarts and
concurrent sweeps never repeat it:

- `budget.threshold_reached`: budget, spend, limit, period, threshold 80.
- `budget.exceeded`: the same at 100%, plus the configured action.

Admins see an in-app banner while any budget is at warning or above, dismissible
per budget, period and state, plus a Budgets card with progress bars on
`/usage`. Pinchy has no outbound mail, and inventing a notification feed is not
this slice.

### Enforcement

- **Web chat:** `ClientRouter` checks before forwarding a send (not history or
  abort). A blocked turn gets error code `policy_budget_exhausted`, rendered as
  not retryable, and a `chat.policy_refused` audit row.
- **Email automations:** the loader skips agents under a blocking, exhausted
  budget, the same paused semantics as Part 1.

A turn that crosses the line finishes. Spend is recorded after the turn, so the
next turn is the one refused.

### API

| Method   | Path                | Who                       | Audit                               |
| -------- | ------------------- | ------------------------- | ----------------------------------- |
| `GET`    | `/api/budgets`      | admin                     | —                                   |
| `PUT`    | `/api/budgets`      | admin + active Enterprise | `budget.created` / `budget.updated` |
| `DELETE` | `/api/budgets/[id]` | admin                     | `budget.deleted`                    |

**Enterprise, as #36 says.** A lapsed license keeps enforcing existing budgets,
the fail-closed rule, but deleting one stays allowed, so an expired license can
never strand an instance with chat blocked and no way to lift it.

### Known limits, stated in the docs

- **Telegram is not blocked.** Its messages go straight into OpenClaw, and the
  allow store would answer a blocked user with a pairing prompt, which is worse
  than continuing. Its spend still counts toward every budget.
- **Uncounted spend:** knowledge-base OCR and `pinchy-files` vision rows carry no
  cost today (`estimated_cost_usd` is NULL), and Ollama models are priced at 0.
- **Insert-time accounting:** a turn recorded late counts in the month it was
  recorded.
- **Not in this slice:** per-user budgets (Telegram rows carry a peer id, not a
  user id), token budgets, other periods, email alerts.

## One PR, not two

Both halves solve the same customer problem and share the enforcement surface:
the chat refusal path and its non-retryable `policy_` codes, the paused-workflow
skip in the loader, the audit vocabulary, and one docs page. Split, the second
PR would rebuild half of the first on a branch that does not have it yet.

## Docs

- New guide `guides/cost-governance.mdx`: both policies, budgets, what members
  see, the limits above.
- `guides/usage-dashboard.mdx`: the Budgets card.
- `guides/user-management.mdx` / `guides/smithers-onboarding.mdx`: personal
  agents can be switched off.
- `guides/email-automations.mdx`: paused automations.
- `concepts/audit-trail.mdx`: the new events.
- `reference/api.mdx`: the new routes.

## Tests

Each enforcement point gets a test that fails without it: the predicate; the
three access helpers and `getVisibleAgents`; the WS refusal frame and audit row;
the Telegram allow store and bindings; the loader skip for both policies and for
a blocking budget; the automation routes; the settings route's audit diff and
side effects; the generic settings route refusing `policy.*`; the spend window
in the org timezone; alert claiming firing exactly once; the budget routes'
Enterprise gate and audit rows; the client rendering `policy_` codes as not
retryable.
