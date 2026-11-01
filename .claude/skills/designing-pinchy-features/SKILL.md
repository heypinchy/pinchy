---
name: designing-pinchy-features
description: Use BEFORE building or changing any user-facing flow in Pinchy — a create form, a config dialog, a wizard, a settings tab, an onboarding step, an empty state — and when the user says a screen is "too complicated", "too long", "asks too much", or "should just work". Decides what the UI asks the user versus what Pinchy figures out on its own. Read it before writing the component, not after the review.
---

# Designing a Pinchy feature

## Why this exists

Pinchy's promise is **security + ease**: enterprise-grade governance that still
feels light. The security half is enforced by tests, guards, and audit rules.
The ease half had no enforcement at all — it lived as voice guidance in
`PERSONALITY.md` and as marketing prose in `docs/concepts/philosophy.mdx`, and
neither is where an agent looks while building a form.

The bill came due with the Automations create form (#139). Its schema requires
**three** things — a name, an instruction, and at least one mailbox. The form
shipped asking for **nine**, giving six optional filter fields the same visual
weight as the required ones, and making the user tick a checkbox to select the
single mailbox their agent could read. Every principle needed to prevent that
was already written down. None of it was reachable from the task.

This skill is that guidance, moved to where the work happens.

## The rule

> **Smart defaults on create. Overrides in settings. Hide the rest until it's needed.**

Three consequences, in order of how often they are violated:

1. **A create flow asks for what cannot be derived — nothing more.** If Pinchy
   can infer it, detect it, or default it sensibly, do not ask.
2. **Every override lives in settings, not in the create flow.** Power lives
   one level deeper, always reachable, never in the way.
3. **There is no "Advanced Mode" toggle.** That is the worst of both worlds: it
   admits the UI is too complex and makes the user configure the configurator.
   Use progressive disclosure on the individual field instead.

## The field test

Before writing a form, count. Then justify.

| Count                                            | Question                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| **R** — fields your schema actually **requires** | Read the zod schema. `.optional()` and `.default(…)` are not required. |
| **S** — fields the form **shows** by default     | Count what renders on open.                                            |
| **D** — required fields you can **derive**       | One readable mailbox → pick it. Name → generate from content.          |

**Ship when `S ≈ R − D`.** If `S` is much larger than `R`, the form is showing
optional configuration as if it were setup. That is the defect this skill
exists to catch.

The Automations form failed this: `R = 3`, `D ≥ 1` (single mailbox), `S = 9`.

## The six patterns

The integrations flows are the reference implementation. They are the most
user-friendly surface in the product — when in doubt, go read them and copy the
shape. (Symbols, not line numbers; lines drift.)

### 1. Ask only what you cannot derive

IMAP asks for **two** visible fields — email and password — and its submit
unlocks on those two alone (`canSubmit` in
`packages/web/src/components/imap-connect-step.tsx`). Host, port, security, and
username all come from an autodiscover call fired on blur. Odoo asks for three
and determines the database itself.

### 2. Generate the name; never open with an empty name field

`packages/web/src/components/add-integration-dialog.tsx` says it outright:
`// --- Connect form schema (no name/description — auto-generated) ---`. The
name is derived from the connection URL by `generateConnectionName()` in
`packages/web/src/lib/integrations/odoo-url.ts` (`mycompany.odoo.com` →
`"Mycompany Odoo"`), prefilled only at the final step, and editable there.

A required, empty "Name" field as the first thing a user sees is a smell. Name
the thing from its content and let them rename it.

### 3. Progressive disclosure — with a touched-lock

Hide the advanced block behind a one-line summary of what was decided, plus an
"Edit" affordance: IMAP shows `Server settings found — IMAP host:993 · SMTP
host:587` instead of six inputs.

The half nobody remembers: **a smart default must never overwrite a field the
user has already touched.** `imap-connect-step.tsx` keeps a `touched` set for
exactly this ("Once the user has edited one of these, prefill leaves it
alone"), and a `userExpanded` lock so a later autodiscover can never re-collapse
a section the user opened. Auto-fill that fights the user is worse than no
auto-fill.

### 4. Conditional fields appear only on genuine ambiguity

The Odoo database field is hidden by default and rendered only when
autodiscover found **several** databases or **failed**. Not "when the type is
Odoo" — when the answer is actually unknown.

### 5. Verify before you save, and fail with instructions

Nothing is persisted before it has been proven to work: "Test & Save" for
web-search, test-then-sync-then-save for Odoo, a live connection test for IMAP.
When it fails, the message is a numbered repair procedure with the user's own
values substituted — and where a known cause has a known fix, a one-click
remedy ("Port 587 is commonly blocked by cloud hosts… Switch to 465 & retry").

Never surface a raw error where a next action is knowable.

### 6. Shape the flow to the task, not to a template

The wizard is a state machine whose length varies by what is actually needed:
web-search is one field and one click; Odoo is three steps. Do not pad a
one-field task into a three-step wizard, and do not compress a genuinely
multi-decision task into one wall of inputs.

## Checklist

Before opening the PR:

- [ ] Counted `R`, `S`, `D` — and `S` is justified against them.
- [ ] Nothing is asked that could be derived, detected, or defaulted.
- [ ] No empty required name field on open (generate it).
- [ ] Optional configuration is behind disclosure, labelled optional, not inline with required fields.
- [ ] Conditional fields keyed to real ambiguity, not to the branch being taken.
- [ ] Any auto-fill respects a `touched` lock and never re-collapses what the user opened.
- [ ] Destructive or connective actions are verified before persisting.
- [ ] Failure messages name the next action.
- [ ] Empty state teaches and offers the first step (see `settings-integrations.tsx`).
- [ ] Copy read against `PERSONALITY.md` — that is the voice authority; this skill is the interaction authority.
- [ ] Applied the Pinchy Test: _could someone set this up without reading a manual?_

## Where the boundary is

This skill governs **what the interface asks and when**. It does not govern:

- **Copy and voice** → `PERSONALITY.md`.
- **Security gates.** Ease never removes a permission check. Deriving a default
  is a UI affordance; the server still validates. Hiding a field is never
  hiding an authorization. "Propose, don't self-activate" and every human-gated
  step stay explicit **because** they are the product, not friction to optimize
  away.

Simplify the question. Never simplify the guarantee.
