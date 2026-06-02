# Dependency patches

`pnpm` applies every patch listed under `pnpm.patchedDependencies` in the root
`package.json` during install (including the production `Dockerfile.pinchy`
build). Patches are a last resort for upstream bugs we cannot wait on; each one
must be minimal, commented in-place, and tracked for removal.

## `@assistant-ui__react@0.14.11.patch`

**What:** moves the `if (isComposing) return;` guard **before** the
`setText(e.target.value)` call in `ComposerPrimitive.Input`'s `onChange`.

**Why:** the composer textarea is a controlled input (`value = composer.text`).
Upstream 0.14.x calls `setText` on every `onChange` _before_ the isComposing
guard, so the runtime text — and therefore the controlled value — mutates while
an IME composition is active. Writing a controlled value back into the DOM
mid-composition aborts the browser's composition session and **freezes the chat
input**: typing an accented character via a dead-key sequence (e.g. `´` then `e`
→ `é`) leaves the field stuck, refusing further input and deletion.

0.12.x returned before `setText` and was safe. The regression rode in with the
0.12.26 → 0.14.11 bump (commit `f7823d907`) and is still present in 0.14.13
(latest at time of writing). The patch keeps 0.14's stale-ref recovery line
intact, so dead keys that never emit `compositionend` still sync.

**Regression guard:** `packages/web/src/components/assistant-ui/__tests__/composer-ime-composition.test.tsx`
renders the real (un-mocked) primitive and asserts the runtime text is not
mutated during an active composition. It goes red on the unpatched dependency.

**Remove when:** assistant-ui ships a release where `onChange` does not call
`setText` during composition. Then bump to that version, delete this patch and
its `pnpm.patchedDependencies` entry, and keep the test as a guard. Tracked in
[#449](https://github.com/heypinchy/pinchy/issues/449).

**Upstream:** this is a regression from the fix for
[assistant-ui#3923](https://github.com/assistant-ui/assistant-ui/issues/3923)
(which made the mid-composition `setText` unconditional to recover dropped
`compositionend` events). The same code is on assistant-ui `main` at
`packages/react/src/primitives/composer/ComposerInput.tsx`. An upstream issue
proposing the guard reorder is pending.
