# CI Workflows

Read this before changing anything under `.github/workflows/` or `.github/actions/`. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

## The Workflow Files Are Linted, And The Linter's Coverage Is Measured

Nothing in this repo read `.github/workflows/*.yml`, and two bugs went through that gap. PR #1063 landed a `ci.yml` GitHub could not parse — which did not fail, it left the required checks on "Expected — Waiting for status" forever, the same unmergeable-with-nothing-broken shape as a workflow-level `paths-ignore` or a matrix on a required job. And `release.yml` / `pre-release.yml` both passed `config-inline:` to `docker/setup-buildx-action`, an input renamed to `buildkitd-config-inline` in v3: an unknown `with:` key is handed to the action as an `INPUT_*` env var it never reads, so the buildkit registry-mirror config was dead from those workflows' first commit until 2026-08-05. Neither is a YAML error nor a shell error — both are _schema_ errors, and `actionlint` is the only checker here that reads the schema.

It runs in `quality` (ungated, so it reports on every PR — and `.github/**` is not docs, which is exactly the PR that can break a workflow), pinned by version **and** sha256 because the step fetches an executable into a job holding a GHCR-write token.

**Both external-linter integrations are off (`-shellcheck=`, `-pyflakes=`), by design.** actionlint is pinned, so it can only change its verdict when someone edits `ci.yml`. shellcheck and pyflakes are not — actionlint shells out to whatever the `ubuntu-latest` image ships, so a runner-image bump that adds one rule turns main red with no commit behind it. Same call AGENTS.md makes for the docs-freshness sweep, with more force, because this gates every merge. The cost is 15 unreported shellcheck findings in `run:` blocks; plain `actionlint`, run locally, still reports them.

**The load-bearing half is the coverage check, not the lint.** actionlint validates a `with:` key only for action versions in its bundled schema database, and for anything else it reports _nothing_ — a silence indistinguishable from a clean pass, with no flag to turn it into an error. Measured with the pinned 1.7.12:

```
docker/setup-buildx-action@v4 + `config-inline:`  ->  exit 1, named
docker/setup-buildx-action@v5 + `config-inline:`  ->  exit 0, silent
```

`config-inline` is the exact bug the lint was added for, so its protection would expire at the next major bump of the very action it protects — and `.github/dependabot.yml` proposes those weekly, grouped under `patterns: ["*"]`. A major bump is also precisely when an input gets renamed.

So `scripts/check-actionlint-coverage.mjs` measures it: one throwaway workflow per action, each carrying an input that cannot exist, fed to the binary CI just verified (`ACTIONLINT_BIN`). Today 12 of 19 refs are validated. The other 7 need an `ACCEPTED_UNCHECKED` entry in `scripts/lib/actionlint-coverage.mjs` **with a written reason**, and it fails in both directions — an entry for an action actionlint now checks, or one naming a ref no workflow uses, fails like any other drift. Pure logic is unit-tested in `scripts/lib/actionlint-coverage.test.mjs` (`pnpm test:scripts`); the probe itself is not, because it needs the binary.

Three things to know before editing it:

- **When a dependabot action bump turns this red, the fix is a newer actionlint — not an acceptance.** An acceptance there would silence the gate on precisely the change it exists to inspect. Nothing proposes the actionlint bump itself (dependabot's `github-actions` ecosystem reads `uses:`, not a curl'd tarball), so this check is also the only thing that tells you the pin has gone stale.
- **The probe must match the ref's legal shape.** A remote reusable workflow (`owner/repo/.github/workflows/x.yml@ref`) is used at job level, not as a step; probing it as a step reads "unchecked" because the probe is malformed rather than because actionlint is silent, and the acceptance would then rest on a broken measurement. `isReusableWorkflowRef` is that branch. The osv-scanner entry is genuinely unchecked — verified at job level.
- **It sees remote refs only.** Local composite actions (`.github/actions/docker-mirror`) get no input validation from actionlint either — verified with a probe — so they are excluded rather than listed as acceptances that assert nothing.

Verify a change to any of it by canary, never by reading: bump `setup-buildx-action` to a major actionlint does not know and watch the coverage check name it; add an acceptance for an action that _is_ checked and watch it fail the other way.

## CI Path Filtering Is Job-Level, Never Workflow-Level

`.github/workflows/ci.yml` must **never** carry `paths-ignore:` (or `paths:`) on its triggers. It hosts main's required status checks, and a workflow that never starts never reports a status — so a docs-only PR would sit forever on "Expected — Waiting for status to be reported": unmergeable, with nothing actually broken. This is exactly what the old `paths-ignore: [docs/**, "**/*.md", ...]` did once those checks became required.

The filter now lives one level down:

- The **`changes` job** diffs the PR against its base and outputs `code=true|false` via `scripts/detect-code-changes.mjs`. Pure logic is in `scripts/lib/ci-path-filter.mjs` (`hasCodeChanges`), covered by `scripts/lib/ci-path-filter.test.mjs` (`pnpm test:scripts`).
- **Ungated jobs** are listed in `UNGATED_JOBS` with the reason each one carries no gate. Two distinct reasons — don't conflate them:
  - `required` (`quality`, `vitest-integration`, `e2e` — the names in branch protection, exposed as `REQUIRED_JOBS`): they must report on every PR, so no required check depends on GitHub's subtle "a skipped job counts as success" behaviour.
  - `docs-relevant` (`links`): the job guards exactly the files a docs-only PR consists of (`**/*.md`), so gating it would skip the check on precisely the PRs that need it. Only worth it for cheap jobs.
- **Every other job** carries `needs: changes` + `if: needs.changes.outputs.code == 'true'`, which is where the CI-minute saving comes from. A gated job is genuinely skipped on a docs-only PR.

Mistakes the drift guards in `ci-path-filter.test.mjs` exist to catch: re-adding `paths-ignore` (the original bug); adding a new job without the gate (it would silently run the full Docker/E2E matrix on every README typo); an `UNGATED_JOBS` entry that is actually gated in `ci.yml` (a list that lies); and a lockfile `vuln-scan` reads that the filter treats as docs.

**Ignoring a path is a claim that no gated job reads it.** `docs/**` is prose with one carve-out: `docs/pnpm-lock.yaml` counts as **code**, because `vuln-scan` scans it — classifying a docs-lockfile security bump as docs-only would skip the very scan that proves the fix and leave main red until someone hand-ran `workflow_dispatch`. Before adding an ignore rule, check which gated job reads those files.

An unresolvable base or empty diff deliberately answers **`code=true`**: wasting CI minutes is recoverable, skipping the matrix on a real code change is not. When adding a job that depends on `build-image`, note that `build-image` is skipped both on fork PRs (fall back to a local build) and on docs-only PRs (build nothing) — only the explicit `changes` gate tells those two apart.

## Never Put A Required Check In A Matrix

A `strategy.matrix` renames a job's status check: `E2E Tests` becomes `E2E Tests (1/2)`. Branch protection matches checks **by name**, so the moment a required job grows a matrix, main waits forever on a name that will never report again — the same unmergeable-with-nothing-broken failure as a workflow-level `paths-ignore`, from the other direction.

The required names are `quality`, `vitest-integration` and `e2e` (`REQUIRED_JOBS` in `scripts/lib/ci-path-filter.mjs`). Sharding any of them means changing branch protection in the same change — **ask first**, it is not a unilateral edit. Every other job is free to shard.

Sharding is worth it only where test time clearly exceeds the **~4m30 fixed overhead** every E2E job re-pays per shard (image pull ~1m30, stack boot ~1m, pnpm/playwright setup, teardown). Today that is `setup-wizard-e2e` (8m22) and `integration` (8m17); `telegram-e2e` (5m19), `odoo-e2e` (4m24) and `email-e2e` (3m32) stay whole, because a second stack would cost more than it saves. Measure before adding a shard — `gh api repos/heypinchy/pinchy/actions/runs/<id>/jobs` gives per-step timings.

Two things a shard must get right:

- **Shard across jobs, never by raising `workers`.** Every Playwright config here pins `workers: 1` deliberately: setup-wizard's specs call `resetStack()` (truncates the DB, restarts containers) and the integration suite shares one OpenClaw session. Two specs in one stack would wipe each other's state. One stack per shard keeps that invariant; `fullyParallel: true` breaks it.
- **Scope the diagnostics artifact to the shard.** `upload-artifact` rejects a duplicate name within a run, so a bare `artifact-name: "<suite>"` from both shards turns a real test failure into an upload error and loses the diagnostics.

Related: the images are built by a `build-images` **matrix** (two runners, ~2× faster than the old serial job) and fanned back in through `build-image`, whose only job is to preserve the `result` + `outputs` contract the 11 downstream jobs already encode. Its `if:` mirrors the matrix's verbatim, and `!cancelled()` plus its guard step is what keeps a _failed_ build from reading as `skipped` — which downstream would take as "fork PR, build locally" and cheerfully rebuild a Dockerfile CI just proved broken. Because a matrix cannot export per-entry outputs, the fan-in recomputes the tags; `scripts/lib/ci-image-tags.test.mjs` pins the two expressions together.

## A Red Playwright Job Must Leave Something Behind

Nine jobs in `ci.yml` run Playwright. Eight got the `capture-e2e-diagnostics` composite action; the ninth — `e2e`, the **required** check, the one whose flakes actually block merges — was the one nobody came back to, so a red required check gave only the list reporter's terse text (#1061). The suite hardest to diagnose was the suite that most needed diagnosing.

Two claims have to hold, and each is invisible when it stops holding:

- **The job uploads Playwright's output when it goes red.** Either `capture-e2e-diagnostics` (docker-compose stacks — it also collects container logs and a secret-redacted `openclaw.json`) or a plain `actions/upload-artifact` for `packages/web/test-results/`. The `e2e` job takes the second route deliberately: it runs Playwright's own `webServer` against a bare Postgres service container, so a synthetic `compose-files` would upload four log files describing a stack that never started. **The step needs an `if:` that survives failure** — one without it runs only on success, so the artifact never appears for the failures it exists for, and nothing is red.
- **The config asked Playwright to write that output.** `playwright.integration.config.ts` set `trace` but not `screenshot`, so the composite action advertised a bundle containing "Playwright traces, screenshots, and full container logs" and shipped one with no screenshots for that suite. Uploading the right directory and filling it are separate claims; CI can only ever observe the first.

`scripts/lib/e2e-diagnostics-coverage.mjs` (+ its test, `pnpm test:scripts`) pins both, over the real `ci.yml` and the real configs, with a corpus floor so a broken sweep cannot pass on an empty comparison. A job whose steps it cannot read **throws** rather than reporting "no offenders" — a clean verdict on unreadable input is how a guard stops guarding the moment somebody reindents a job.

Two things worth knowing before editing it:

- **The upload path is one directory for every config, including the nested one.** Playwright's default `outputDir` is `path.join(packageJsonDir, 'test-results')` — the nearest **package.json**'s directory, not the config's. `packages/web/eval/` has no package.json, so `eval/playwright.eval.config.ts` writes to `packages/web/test-results/` like all the others. Verify a change to this by reproduction, not by reading the config: the resolution rule is neither "relative to the config" nor "relative to cwd", and guessing either way gets it wrong.
- **It is a tripwire, not a proof that a failure is diagnosable.** `trace: "on-first-retry"` is a legitimate value that captures nothing here, because every config pins `retries: 0` on purpose (§ "No Untracked Sleeps In E2E" — a flake is a signal). The guard would not notice. Review still owns that case.

## Every Job Sets `timeout-minutes` — Except The Ones That Must Not

GitHub's default job timeout is **360 minutes**, and until this guard landed no job in any of the ten workflow files set one. A hung `docker compose up`, a stuck poll loop or a wedged `docker compose pull` therefore tied up a runner for six hours instead of failing fast — and everything queued behind it, including a merge-queue run waiting on a required check, waited the same six hours.

`scripts/lib/workflow-timeouts.mjs` + its test (`pnpm test:scripts`) require a job-level `timeout-minutes` on **every** job in **every** workflow — including the cron-only ones (issue-triage, docs-freshness, sbom, prune-ghcr), because a hang nobody is watching is the one that goes unnoticed longest — with a 10-minute floor.

**The exception is why the guard checks both directions.** A job that calls a reusable workflow (`uses:` at the job's own indent) accepts only `name`/`uses`/`with`/`secrets`/`needs`/`if`/`permissions`. A `timeout-minutes` there is not ignored, and does not fail just that job: GitHub refuses to parse the **whole file**, the run ends in seconds with no jobs, and no status is ever reported. On `ci.yml` that is every required check silently never arriving — the same unmergeable-with-nothing-broken failure as a workflow-level `paths-ignore`, reached from a third direction. The first draft of this very change shipped it on `vuln-scan` and `release.yml`'s `docs`, and both CI and Release died at 0s. So such a job is **exempt from needing** a timeout and **rejected for having** one; its timeout belongs on the called workflow's own jobs (`screenshots.yml` sets its own; a third-party reusable workflow's are not ours to set).

**Size a timeout from measured runs, not from a guess.** `gh api repos/heypinchy/pinchy/actions/runs/<id>/jobs` gives per-job durations; the rule here is at least **2× the max across recent green runs**. The asymmetry is the argument: a too-generous cap costs nothing until something actually hangs, while a too-tight one turns a healthy run red on a repo whose Playwright configs pin `retries: 0` precisely so that a red run means something. Watch the Docker image builds — their cost is registry throughput and buildx cache hits rather than work done, so they are bimodal: `pre-release` alone spans 10m to 37m across ten green runs, and a 25-minute cap would have cancelled a build that really did succeed.

`actionlint` reports the reusable-workflow mistake in about a second with the exact allowed-keys list. It is not wired into CI, so run it locally after editing a workflow — the regex guard here encodes one known trap, not GitHub's whole schema.

## A Job That Rebuilds An Image It Already Holds Reclaims The Disk First

`docker-smoke` pulls the pre-built Pinchy and OpenClaw images, tests them, runs `docker compose down -v` — which removes containers and volumes, **never images** — and then starts the dev stack with `up --build`, which builds `Dockerfile.pinchy.dev` and `Dockerfile.openclaw` from scratch. Both copies on one runner disk ran the OpenClaw build out of space at `COPY --from=builder /opt/llama-cpp-deps` (`ResourceExhausted: … no space left on device`, CI run 42014766282; #1256, #1279 and #1285 lost runs the same way). Each step is fine alone; the failure is the sum, so nothing in the workflow looked wrong.

It failed only on **AWS-hosted** runners. Of 31 docker-smoke attempts on 2026-11-05, all three on AWS died of ENOSPC; of the 28 on Azure, 27 passed and one failed for an unrelated reason — an Azure ubuntu-26.04 runner has a 145G root with 88G free at job start. So "it is green on my rerun" was the runner lottery, not a fix. Measured on Azure (#1293): the two pulled CI images cost ~10G, the dev build alone ~16G.

`.github/actions/reclaim-docker-disk` removes every `ghcr.io/heypinchy/*` image and bare `pinchy*` tag and the preinstalled toolchains no Pinchy job uses (.NET 5.8G, Android SDK 12G, GHC/ghcup 3.7G, CodeQL's tool-cache bundle — the rest of `/opt/hostedtoolcache` stays, `setup-node` reads it). It prints `df` and `docker system df` before and after, then **fails with `::error::` if less than `min-free-gb` (default 22G) is free on the filesystems holding Docker's and containerd's data (the hosted runners use the containerd image store, so layers live under `/var/lib/containerd`)** — a named shortfall instead of an ENOSPC halfway through a `COPY`. A pulled image is not an input to the rebuild — a plain `docker build` does not use one as cache — so removing it costs nothing but the space. The BuildKit cache is kept on purpose: on a fork PR it holds the local prod builds, so removing their tags there frees little — but the dev build of `Dockerfile.openclaw` (same file, same context) then reuses that cache and adds almost nothing, which is why docker-smoke passes a lower floor (12G) on the fork path. The step itself stays unconditional; only its `min-free-gb` input differs. If a build runs out of space after passing the floor, raise the floor from the printed `df`; if the floor trips, free more space — never lower it to get green.

`scripts/lib/docker-rebuild-disk.mjs` (+ its test, `pnpm test:scripts`) is the tripwire across every workflow: once a job holds a Pinchy image (pulled the CI images, `docker pull`ed one, or built one into the local store), a later step that builds one must come after the reclaim action. Details worth knowing before editing it:

- **A compose `--build` counts only if a `-f` file builds from the repo root.** The mocks build from their own directories and weigh a few MB; counting them flags `screenshots.yml`'s fake-ollama. A `-f` that arrives through a variable (`$COMPOSE_FILES`) cannot be read and counts — unreadable input fails loud.
- **`build-push-action` holds a local image only with `load: true`.** A pushed image never lands in the local store, so release's two pushes in a row are fine.
- **Steps whose `if:` pin `needs.build-image.result` to different values never both run** — the pull on a same-repo PR, the local build on a fork PR — so they do not count against each other. An `||` in either condition voids that.
- **Builds inside one step are not compared; a pull and a build in one step are.** The fork fallbacks build Pinchy and OpenClaw back to back in one step — two different images, not the doubled-image shape. A pull followed by a rebuild in one `run:` is the incident on one line, and is reported.
- **A reclaim with an `if:` other than `always()` clears nothing.** It may not run; put the condition on the build, or on the action's inputs, instead.
- **It reads workflow steps only.** A pull or build inside a local composite action other than `pull-ci-images` is invisible to it, and so is an implicit pull (`docker run` or `compose up` of a missing image).
- **The action removes what the guard counts.** Both `ghcr.io/heypinchy/*` and bare `pinchy*` tags (`pinchy:e2e`): a reclaim that leaves an image the guard counted would turn the guard green over a full disk.
