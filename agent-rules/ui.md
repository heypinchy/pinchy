# UI Flows And Error Display

Read this before building a create form, config dialog, wizard, settings tab or onboarding step, or deciding how an error is shown. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

## User-Facing Flow Design

Before building a create form, config dialog, wizard, settings tab, or onboarding step, invoke the **`designing-pinchy-features`** skill. It is the interaction authority the way `PERSONALITY.md` is the voice authority.

The rule it enforces: **smart defaults on create, overrides in settings, everything else hidden until needed.** A create flow asks only for what cannot be derived. There is no "Advanced Mode" toggle — that admits the UI is too complex and then makes the user configure the configurator.

Count before you build: `R` = fields the zod schema truly requires (`.optional()`/`.default()` do not count), `D` = required fields you can derive (one readable mailbox → pick it; a name → generate it), `S` = fields the form shows on open. Ship when `S ≈ R − D`. The Automations create form shipped at `R = 3`, `D ≥ 1`, `S = 9` — which is the failure the skill exists to prevent. The integrations connect flows (`add-integration-dialog.tsx`, `imap-connect-step.tsx`) are the reference implementation.

Simplify the question, never the guarantee: deriving a default is a UI affordance, and the server still validates. Hiding a field is never hiding an authorization.

## Error And Notification UI

Use inline form errors when the error is tied to a field, the user can correct the input, and the form/dialog stays open.

Use toast notifications for completed actions, background/system errors, and transient errors the user can simply retry.

Use a persistent, dismissible inline banner (not an auto-expiring toast) for a permanent, actionable error that lands after a full-page redirect — e.g. an OAuth connect failure surfaced via a `?error=` query param. "The action navigated away" does NOT by itself justify a toast: after a redirect the user's attention is on the provider, so a few-second toast is gone before they read it, and the error needs a configuration fix that outlives a toast. Classify by whether the error is transient-and-retryable (toast) or permanent-and-actionable (persistent inline banner), not by whether the flow navigated.

Do not mix inline errors and toast errors for the same action. Success confirmations should be toasts unless a multi-step flow intentionally shows a success screen.

One exception: copying a value is confirmed in place, not with a toast. Every link or secret Pinchy hands out goes through `CopyField` (`packages/web/src/components/copy-field.tsx`), which turns the button into "Copied" for about two seconds and announces it through a polite live region. The confirmation belongs to the button the user just pressed, and an extra toast would make screen readers announce it twice. A copy the browser refuses is not a success either: `CopyField` selects the value and says to press Ctrl+C, so never toast "Copied" without checking the result of `useCopyToClipboard().copy`.
