# Documentation Checks

Read this before changing `docs/`, a user-visible surface or a docs check, and before opening a PR. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

### In-Page Anchors Are Checked By The Docs Build

A link to a heading that does not exist — `[see the config](/guides/setup/#nope)` — used to be caught by nothing (#769). The `links` job (lychee) passes `--exclude-path docs` **on purpose**: in the source `.mdx`, `/guides/setup/#configure-openclaw` is a route into the _generated_ site, not a file on disk, so checking it there produces noise rather than signal. And the astro build fails on MDX _syntax_ while being perfectly happy with a dead anchor. So the docs — the thing users read, and the thing Smithers reads on demand through `pinchy-docs` — were the one place a broken link shipped silently. Five were live on docs.heypinchy.com when the check landed, two of them because a `<Badge>` inside a heading gives it a trailing hyphen (`#access-tab` is really `#access-tab-`).

The check is `docs/scripts/check-anchors.mjs`, run by `pnpm -C docs check:anchors` **after** `pnpm -C docs build`. It reads `docs/dist/` — every `<a href>` and every `id="…"` in the HTML that actually ships — and resolves the two against each other. Same rule as the X-Frame-Options gate above: assert what a concrete URL resolves to, not what a source file asked for. `scripts/lib/docs-link-gate.test.mjs` (`pnpm test:scripts`) pins the wiring, including the **order**: the checker reads the build's output, so a check that runs first passes against a stale dist.

It lives in `quality` because `quality` already builds the docs and is ungated (see § "CI Path Filtering Is Job-Level, Never Workflow-Level"). A job of its own would have needed a `changes` gate and then skipped on exactly the docs-only PRs it guards — bug #764 from the other direction.

**Do not reach for `starlight-links-validator` instead; it was tried and it does not work here.** The plugin registers its collectors through `markdown.remarkPlugins`/`rehypePlugins`, which Astro 6.4 deprecated and `@astrojs/mdx@5` no longer forwards. Against our 64 `.mdx` pages and one `.md` page it collects nothing from the `.mdx` files, reports one _bogus_ "invalid link" from the `.md` one, and misses a deliberately broken anchor entirely — a gate that fails loudly on the wrong thing while checking nothing. Both `0.24.1` (the Astro 6 line) and `0.25.2` (Astro 7 / Starlight ≥ 0.41) behave that way here. The docs are on Astro 7 now (#851), and that made it worse rather than better: Astro 7's default Markdown processor is **Sätteri**, which runs no remark or rehype plugins at all — the same reason `@pasqal-io/starlight-client-mermaid` silently stopped rendering diagrams (see below). Revisit only once a version registers on `markdown.processor`, and then only with the canary below.

#### A second check reads the built site: does the markdown render?

`check:anchors` asks whether links resolve. It says nothing about whether a page is legible, and v0.9.0 shipped 41 of 69 pages where every table was a paragraph of literal `|` characters. astro@6 deprecated `markdown.gfm` and leaves it `undefined`; `.md` falls back to the default (`true`), but `@astrojs/mdx@5` reads `config.markdown.gfm` and takes `undefined` as off — so every `.mdx` page lost remark-gfm. Nothing was red: the build succeeded, prettier sees a paragraph and formats it as one, and the anchor check only ever looked at links.

Under astro@6 the fix was `markdown.gfm: true` in `docs/astro.config.mjs`. Since the Astro 7 upgrade (#851) the option is **gone, on purpose**: both `.md` and `.mdx` run through Sätteri, whose MDX renderer resolves an unset gfm to `true`, and astro@7 warns on the option. Measured when it was removed: without it every table renders; with `gfm: false` `check:rendered` fails on 47 pages — so the guard still sees the failure, which is what makes removing the line safe.

`docs/scripts/check-rendered-tables.mjs` (`pnpm -C docs check:rendered`, in `quality` after the build) is the guard, and it checks the **symptom**, not the config: a built page containing a line that both starts and ends with `|`. The next way to lose gfm will not look like this one, but it will look like this in `dist/`. `scripts/lib/docs-link-gate.mjs` pins both built-site checks — script, checker, and the ordering.

The same guard also pins `pnpm -C docs test`, which runs **before** the build (it reads its own fixtures, not `dist/`). Both checkers are ordinary code, and a checker rewritten to find nothing passes cheerfully against a healthy `dist/` — their unit tests are the only thing that would notice. Until #1007 those tests ran nowhere but on a developer's laptop, which is the same shape as the gate that reports on what it looks at rather than what it should.

The general rule is the one the X-Frame-Options gate follows: assert what a built page contains, not what a source file asked for. Neither check covers `<img src>`, and external links out of `docs/` stay unchecked.

`check:rendered` errs loud rather than silent, deliberately: **inline** code is not stripped, so a page that documents table syntax in an inline `` `| a | b |` `` on a line of its own would be flagged. Nothing in the 69 pages does that today. If one ever needs to, rewrite it as a fenced block — do not teach the checker to skip `<code>`, because a real unrendered row containing inline code (``| `foo` | bar |``) lives in exactly that markup.

#### A third check reads the built site: did the diagrams render?

The first Astro 7 build (#851) was green on every check and shipped the architecture diagram as a code block of raw Mermaid source. `@pasqal-io/starlight-client-mermaid` registered its transform through `markdown.remarkPlugins`, and Astro 7's default processor (Sätteri) does not run remark plugins — no error, no warning, the block just fell through to Expressive Code. The replacement is `docs/src/integrations/mermaid/` — a Starlight plugin that pushes a Sätteri **mdast** plugin onto `config.markdown.processor` (the object Starlight, Expressive Code and `@astrojs/mdx` all read) plus a `MarkdownContent` override that renders the `<div class="mermaid">` containers in the browser. It **throws** if the configured processor is not Sätteri, because a silent skip is the failure it replaces.

`docs/scripts/check-rendered-diagrams.mjs` (`pnpm -C docs check:diagrams`, in `quality` after the build, pinned by `docs-link-gate.mjs`) is the guard, in two directions: a built page with a code block whose language is `mermaid` fails, and so does a built site with fewer diagram containers than top-level ` ```mermaid ` fences in the source — a renderer that _drops_ the block leaves no code block to flag. The count is compared **per page** (a source file's route, frontmatter `slug` included), not site-wide — a surplus on one page must not hide a drop on another — and it follows what actually renders: a fence quoted in a longer fence, an indented fence in `.md` (MDX disables indented code, so there it still counts) and a fence inside a comment are not diagrams. The integration also sets `vite.optimizeDeps.include: ["mermaid"]`: the client reaches mermaid only through a dynamic import, and without the hint `astro dev` discovers it mid-session. Its unit tests sit in `docs/scripts/mermaid-integration.test.mjs`, so the pinned `scripts/*.test.mjs` glob runs them. Canary: remove `starlightMermaid()` from `astro.config.mjs`, build, watch it name `/architecture/`.

#### `llms.txt` Is Generated, Never Committed

`llms.txt` and `llms-full.txt` are what AI crawlers read instead of the site. Both used to be hand-written files under `docs/public/`, and both rotted precisely the way § "A Hand-Maintained List That Mirrors Code Will Be Wrong" predicts. Measured on 2026-08-04 (#1080): the index listed **12 of 66** pages, the full text carried **9**, and what it carried described April-era Pinchy — `Auth.js` for an app that runs Better Auth, dev database port `5433` for a stack that binds `5434`, and not one mention of IMAP or the knowledge base. Live, on docs.heypinchy.com, for months. Nothing was red, because nothing read them.

`docs/scripts/generate-llms-txt.mjs` writes both into `dist/` from `src/content/docs`, so a new page is in both files on the next build. Five details are load-bearing:

- **It runs INSIDE the build** — `astro build && node scripts/generate-llms-txt.mjs`, wrapped by `with-restore.sh`. `dist/` has to exist to write into, and the source tree only carries injected `%%PINCHY_VERSION%%` values until the restore step. Moved after it, the generator publishes the literal placeholder inside install commands, to every crawler. `findLeakedSource` in the checker is the tripwire for exactly that ordering mistake — verified by reproduction (run the generator standalone after a build: 21 problems, all placeholders).
- **Sections come from the directory tree, not a label map.** A map would be the hand-maintained list this replaced, one level up.
- **`check:llms` reads `dist/`, both directions.** Every page the built site serves is in both files, and every entry in them is a page the site serves. A documentation page is defined as one carrying Starlight's `generator` meta — that is what separates the 66 real pages from `public/installing.html` (the 1-click-deploy splash) and astro's redirect stubs, without a list of exceptions.
- **The generator is also the guard for aside types.** Starlight renders `:::note`, `:::tip`, `:::caution`, `:::danger` and nothing else; remark-directive eats anything else and emits a bare `<div>` — no colour, no icon, no label, no error. Two `:::warning` blocks shipped that way. The generator has to read the directive anyway, so it throws and names the file.
- **Inline code is verbatim, exactly like a fenced block.** A prose placeholder is shaped like a component tag, so running the JSX stripper over a code span _deletes documentation_: `` `env.<VAR>` `` became `` `env.` ``, and the API reference published `"at": ""` for a field that carries a timestamp. **`check:llms` structurally cannot see this** — `findLeakedSource` asks what survived, and the failure mode is a deletion. The guard is instead `generate-llms-txt.test.mjs`'s corpus test: every single-line code span in every page must appear in that page's output. It reads the same corpus the build does, so a page added tomorrow is covered the day it lands; spans that _wrap across a source line_ are re-flowed on purpose and are the one thing it cannot speak for. Verify a change to it with a canary — put the strip back, watch it name `secrets.md`, `api.mdx` and `upgrading.mdx`.

The committed `public/llms*.txt` are gone. Do not re-add them: a file in `public/` wins over nothing and rots in silence, which is the whole bug.

### A Hand-Maintained List That Mirrors Code Will Be Wrong

The 2026-07-30 post-release docs audit found the same defect in three files: `reference/api.mdx` documented 60 of 96 API routes, `concepts/audit-trail.mdx` listed 47 of 56 audit event types, and `concepts/agent-permissions.mdx` — the canonical "what can an agent do" page — never mentioned `knowledge_search`, the tool behind the release's headline feature. Three whole feature families (Automations, OpenAI-compatible providers, IMAP) had shipped with no reference entry at all.

The control group is the argument: `contracts.tools` did **not** drift, because `manifest-tools-drift.test.ts` guards it. The one list with a guard is the one list that stayed correct. Diligence does not scale; a diff does.

So every docs list that mirrors something derivable from code now has one:

- **`scripts/lib/docs-coverage.test.mjs`** — every API route appears in the API reference, **method and path**. That pairing matters: the audit's own manual pass compared paths only, and therefore missed `PUT /api/enterprise/key` documented as `POST`, and a whole Domain Lock section documenting a `PUT` that does not exist (the route is `POST` + `DELETE`, and its response fields were wrong too). It also checks that every `AuditEventType` appears in the audit-trail reference and every grantable tool in the permissions reference. Reading BOTH the tool registry and the plugin manifests is load-bearing — `knowledge_search` is in no registry, it reaches an agent only through the Knowledge Base template, so a registry-only check would have kept missing exactly the tool that went undocumented. It also checks the newest upgrade section's **Database migrations** list against `packages/web/drizzle/meta/_journal.json`: the range must end at the last migration, and the bullets must name every migration in it and none outside it. It reads only the **newest** `## Upgrading from` section, never a released one (see § "A Released Upgrade Section Is Immutable"): the section `pnpm release` opens has no `Database migrations` subsection, and the first migration after a release fails with "add a `### Database migrations` subsection" to that open section rather than being sent into the frozen one. A range of one migration is written as a single `` `0079` ``.
- **Both directions, because the worse one is docs → code.** `findGhostEndpoints` fails on a documented endpoint no handler serves. A code → docs check is structurally blind to it — the Domain Lock section's real `POST` and `DELETE` were both documented, so that half read green while the section as a whole described a `PUT` that never existed. Running the reverse check for the first time found one still live: `POST /api/settings/providers`, complete with a request-body table naming a `baseUrl` and an `isDefault` the real route (`POST /api/setup/provider`) has never accepted. An undocumented endpoint costs a reader a grep; a documented one that isn't there costs them an afternoon.
- **`scripts/lib/docs-consistency.test.mjs`** — no docs page is orphaned from the sidebar (`security/secrets.md` was reachable only from inline links for months); every `Settings → X` names a tab that exists (four pages still said "Settings → Providers" after the rename to "AI Provider" — one commit had claimed to align them all); and every forward-looking promise cites a tracking issue.

Both run under `pnpm test:scripts` in the `quality` job — no new CI wiring, no docs build needed.

Three rules keep them honest. **Exemptions carry a reason and are themselves checked**: an exemption naming a route, event, or tool that no longer exists fails, because a stale exemption is the same drift one level up. **Each check asserts it found a real corpus** (`handlers.length > 50`) — a broken walker that finds nothing would otherwise pass in silence, which is how a coverage gate becomes decoration.

And **an extractor throws on input it cannot read, rather than returning a short list**. A corpus floor only catches a walker that finds _nothing_; it is useless against one that finds most things. `extractAuditEventTypes` matched two dot-separated segments and so dropped all three `file.upload.*` events — 61 of 64 checked, `> 40` satisfied, silent. It now asserts that every quoted member the union declares came back, so a new event shape is an error instead of an omission. For the same reason, "is it documented?" is a whole-word match and not `String.includes`: a page mentioning `user.invite_blocked` must not count as documentation of `user.invite`.

#### Forward-looking claims need an issue, for the same reason skips do

A script cannot know whether "a progress UI is planned for a later phase" is still true — and it wasn't: the progress UI had shipped, and the same page described it 120 lines earlier. So the check does not judge the claim. It requires the sentence to **name a tracking issue**, which converts an un-checkable promise into a checkable one: a closed issue behind a "planned" sentence is a doc describing a world that no longer exists. Same contract as § "No Untracked Test Skips" — the issue number is what makes the promise auditable.

Keep `FORWARD_LOOKING_PHRASES` narrow. It matches commitments ("on the roadmap", "in a later phase"), never descriptions of the present: an invite "not yet claimed" and an upload "not yet part of a conversation" are ordinary prose, and a check that flags those gets switched off within a week.

The payoff is the weekly `docs-freshness.yml` cron: it takes the issues those sentences cite, asks GitHub which have closed, and reports the docs still promising something the repo already shipped. A cron rather than a PR gate on purpose — the question needs the network, the answer changes without anyone touching the repo, and a check that can go red between two identical commits does not belong in front of a merge button. A claim citing several issues is stale only when they are **all** closed, and an issue the API could not answer for counts as unknown, never as closed.

### A User-Visible Change Needs A Docs Change

The bullet above ("when behavior changes, update docs in the same PR") has been in this file for as long as it has existed, and nothing enforced it. `scripts/check-docs-required.mjs` does now, PR-only in the `quality` job — the same shape as the test-deletion guard.

It fails when a PR touches a **user-visible surface** and no file under `docs/`. The surfaces are listed in `scripts/lib/docs-required.mjs`: an API route, the tool registry, an agent template, the audit event catalogue, the settings navigation, a plugin's declared tools. Deliberately **not** every source file — a guard that fires on refactors gets an escape hatch typed into it reflexively, and then it guards nothing. Run against the three commits that actually caused the v0.9.0 drift (the Automations management API, the OpenAI-compatible delete route, the IMAP test endpoint), it fires on all three.

The escape hatch is the `docs-not-needed` label, or a commit trailer:

```
Docs-not-needed: gateway-only ingress, no reader-facing path
```

A written reason, **not** an issue number — and that difference from the skip and test-deletion guards is deliberate. A skip _defers_ work, so it needs somewhere for the work to live. "No docs needed" _asserts a fact_, and the useful artefact is the assertion itself, sitting in the history next to the change it describes. An issue number here would be a placeholder for an issue nobody ever opens. Bare non-answers (`n/a`, `none`) are rejected by length.

What this guard cannot do is check that the docs change is the _right_ one. That is `review-docs`'s job.

### Some Docs Checks Can Only Be Read, Not Run

The CI guards find missing **identifiers**. They cannot read a sentence, and the four worst findings of the v0.9.0 audit were all sentences:

- `GET /api/settings/domain` was documented with the wrong **response fields** — path and method both correct, body fiction.
- A page promised "a progress UI is planned for a later phase" while **describing the shipped progress UI 120 lines earlier**.
- "Agent templates and default permissions" listed **2 of ~35** templates, with the wrong tools on the row that mattered.
- A live guide said "Pinchy will not silently re-assign agents" about code that does exactly that.

The `review-docs` skill (`.claude/skills/review-docs/`) is that reading pass: scope the behaviour change, grep the docs for the thing **and its consequences**, then check the claim, the specifics (response fields, status codes, defaults, limits — wrong far more often than names are), self-contradiction within a page, and contradiction across pages. It also asks the one question no guard asks: does a doc describe something the code **no longer has**?

It is deliberately not a CI job: it wants the whole repo in context and produces prose the author acts on immediately, not a bot comment on a diff.

#### The skill has a trigger, because an instruction is not one

"Run this before opening a PR" is the same kind of sentence as "update docs in the same PR" — the one that sat in this file for a year while three feature families shipped undocumented. So the skill does not rely on being remembered.

`.claude/settings.json` registers a `PreToolUse` hook on `Bash(gh pr create*)` → `scripts/hooks/require-docs-review.mjs`. It diffs the branch against the PR's base, reuses `analyzeChangedPaths` from the docs-required guard, and **denies the tool call** — with the list of surfaces and what to do about it — unless one of these holds:

- the branch moved no user-visible surface (a docs-only or internal PR is never blocked);
- a review is recorded for **this exact HEAD sha**;
- a `Docs-not-needed:` trailer is in the branch's commits — the same escape hatch the CI gate honours, so one decision is recorded once.

`scripts/mark-docs-reviewed.mjs` writes the marker, and writes the HEAD sha into it. Land another commit and the recorded sha stops matching, so the review expires with the state it reviewed. The marker lives at `git rev-parse --git-path pinchy-docs-review` — untracked, per-worktree, and resolved that way rather than as a literal `.git/…` because inside a worktree `.git` is a file pointing elsewhere.

Two properties worth keeping if you touch it:

- **It fails open.** A hook that breaks must never make it impossible to open a pull request. Unreadable payload, unresolvable base, git not answering — all of them `allow`.
- **It is not a security boundary and does not pretend to be.** An agent can write the marker without reading a line, exactly as a human can `git push --no-verify`. It exists to make _forgetting_ impossible, which is the failure mode that actually happens.

### The Deployed Docs Are The Release Branch, Not `main`

`docs.yml` is manual-only; the real deploy path is `release.yml` → `screenshots.yml`, checked out at the tag. So **a docs fix merged to `main` is not live until the next release**, and a correction that belongs to the shipped version has to be backported like any other fix.

The v0.9.0 audit found exactly one live-docs error this way: the provider-removal section on `release/0.9` said "Pinchy will not silently re-assign agents", while v0.9.0's `DELETE /api/settings/providers` calls `migrateAgentsOffDeletedProvider` and does precisely that. The corrected wording had been on `main` since before the cut and was never carried over.

At release time, diff `docs/` between the release branch and `main` and classify every hunk: **main-only feature** (leave it) or **correction that applies to the shipped version** (backport it). The `cut-pinchy-release` skill carries this as a step.

Do not "fix" this by deploying docs from `main` instead. Pinning the docs to the release is what makes them describe the software users actually run; the cost is a backport, and the backport is the cheaper half.

`docs.yml`'s manual dispatch takes a required `pinchy_version` input for the same reason: without it, `inject-version.sh` falls back to the newest release `upgrading.mdx` records, which is the right answer for a check build and the wrong one for a **publish** — a "just fix this typo" dispatch made while the next release is being prepared would render the previous version across the live install instructions, silently and plausibly. The input makes the operator say which release they are publishing docs for.

**Verify a change to either gate with a canary, never by reading the code.** For anchors: add a link to a heading that does not exist, build, confirm the check fails on that exact link, remove it. For tables: add `markdown: { gfm: false }` to `docs/astro.config.mjs`, build, confirm `check:rendered` fails and names an affected route, set it back. The anchor canary is what caught `starlight-links-validator` being a no-op; nothing cheaper would have, and a passing unit suite would not have — these checkers are only ever proved by a real broken page.

Unrelated to the anchors but found while building them: `pnpm -C docs build` now runs `scripts/with-restore.sh astro build` rather than `astro build && restore`. The old `&&` chain short-circuited, so a failed or interrupted build left `vX.Y.Z` injected into the six committed source files `inject-version.sh` touches — and stayed that way, because the next run found no placeholders to inject and therefore registered nothing to restore. The wrapper restores either way and forwards the exit code.

What it does **not** cover, so nobody reads the green check as more than it is: only `<a href>` elements, never `<img src>`. Every `![…](/screenshots/….png)` is still checked by nothing — and has to be, because `docs/public/screenshots/` is written by `screenshots.yml` at release time and does not exist in a normal checkout, so checking it would fail every build rather than catch anything. External links out of `docs/` remain unchecked too; that is the `--exclude-path docs` half this did not close.
