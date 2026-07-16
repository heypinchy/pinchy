# KB Eval Harness — methodology (pinchy KB Eval Harness plan, `docs/plans/2026-07-16-kb-eval-harness.md`)

The Knowledge Base's product promise is "auditable, regression-protected
groundedness": every answer cites its sources, and a change that degrades
retrieval quality or citation integrity shouldn't be able to ship. This
harness is what turns that promise into enforced, measured reality instead of
a claim nobody checks.

**The crux the harness is built around:** groundedness — "is this claim
actually supported by what it cites" — can only be judged by another model
(an NLI judge). A model-in-the-loop judge is non-deterministic: same input,
occasionally different output. That cannot be a flaky red/green PR gate — a
gate that sometimes fails for no code reason trains people to ignore it. So
the harness is split by determinism, not by topic: two deterministic layers
with no model in the loop are hard CI gates, and the one layer with a model
in the loop is tracked evidence, not a gate.

## The three layers

| Layer                  | What it checks                                                                                                                 | Determinism                | CI status                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------ |
| 1 — Retrieval-Gate     | recall@k / MRR / nDCG@k + dedup provenance, over a committed synthetic corpus + committed embeddings                           | Deterministic              | **Hard gate** — `vitest-integration` job   |
| 2 — Attribution-Gate   | citation integrity (bidirectional inline↔Sources match, full-path citations, markdown format, no near-duplicate corroboration) | Deterministic              | **Hard gate** — `integration` job          |
| 3 — Groundedness-Sweep | per-sentence NLI entailment, answer relevance, citation correctness                                                            | Stochastic (LLM/NLI judge) | **Tracked, not a gate** — manual/on-demand |

### Layer 1 — Retrieval-Gate (`src/lib/eval/kb/retrieval-eval.ts`, `src/lib/eval/kb/metrics.ts`)

Scores the real `retrieve()` function against a gold `(query → expected chunk
ids)` set (`eval/kb/corpus/gold-queries.ts`), over a synthetic corpus seeded
into a real Postgres. Query embeddings are **committed fixtures**
(`eval/kb/corpus/embeddings.json`), not computed live, so no embedding model
is in the loop — only our retrieval/RRF/scoping SQL is under test, which is
what makes this fully reproducible and keylessly runnable in CI.

The gate lives in the integration test suite under
`src/__tests__/lib/knowledge/kb-retrieval-eval.integration.test.ts`, which
`test:db` (and therefore the `vitest-integration` CI job) already picks up —
no separate CI job needed for this layer. It asserts a recall@10 / MRR floor
over the gold set, plus a per-axis check (`happy`, `path-citation`, `dedup`,
`multi-hop`, `distractor`, `cross-lingual`) so a regression on one behavior
doesn't hide behind an aggregate average.

**Dedup axis note:** the original plan assumed near-duplicate chunks across
paths should collapse in retrieval. That premise was wrong —
`kb_documents` is keyed by `(org_id, source_path)` by design, because
per-path `allowed_paths` access control needs two byte-identical documents in
different folders to stay distinct. So Layer 1 asserts the opposite: for the
dedup gold query, retrieval must return chunks from **both** near-duplicate
paths (provenance preserved). The near-duplicate _rate_ is logged as
telemetry (`nearDuplicateSourcePaths()`, behind `KB_EVAL_VERBOSE`), not gated
here — "don't let a reworded duplicate look like independent corroboration"
is a citation-integrity concern, which is Layer 2's job
(`gradeNoDuplicateCorroboration`).

### Layer 2 — Attribution-Gate (`src/lib/eval/kb/attribution-graders.ts`)

Pure graders over an `(answer text, retrieved sources)` pair — no I/O, no
model in the loop. Fed by scripted fake-ollama answers (`kb-eval-shared.ts` +
triggers in `e2e/shared/fake-ollama/fake-ollama-server.ts`), so both the
well-formed answer and one fixture per defect (unresolved citation, uncited
source, bare-filename citation, run-on Sources format, near-duplicate
corroboration) are deterministic and keyless.

The self-test spec is `e2e/integration/kb-attribution.spec.ts` — it lives
under `e2e/integration/` on purpose, because that's exactly the testDir the
`integration` CI job already runs (`playwright test --config
playwright.integration.config.ts`). No new CI job was added; being in that
directory **is** the gate.

**Grade the raw text, not the rendered DOM.** The graders match literal
markdown syntax the LLM emits (`- [N] ...` bullets, a `**Sources:**`
heading). The chat UI renders that markdown through react-markdown +
remark-gfm into real `<ul><li>` elements, and `.innerText` on the rendered
DOM drops the leading `- ` — so a DOM scrape corrupts every grader (verified
empirically: a rendered bullet's `.innerText` comes back with no `- ` at
all). The self-test grades the scripted response constant (the raw text
fake-ollama actually sent) and only uses a DOM substring as a round-trip
sanity check that the message made it through the real stack. The Layer 3
sweep (below) follows the same rule and captures raw text via the
diagnostics-export API, never the DOM.

### Layer 3 — Groundedness-Sweep (`src/lib/eval/kb/groundedness-grader.ts`, `nli.ts`, `answer-graders.ts`)

The real KB agent answers a gold Q/A set (`eval/kb/corpus/gold-qa.ts`)
against a real Ollama Cloud model. Each answer sentence is checked for NLI
entailment against the passages it cited, plus separate answer-relevance and
citation-correctness graders (a sentence can be entailed yet off-topic — the
design draws a hard line between those two failure modes). Results feed a
Wilson-interval + pass^k scorecard, following the same pattern as the
existing invoice-eval `models` sweep (`../README.md`).

This is deliberately **not a gate**. It's manual/on-demand, needs a paid
API key, and its whole point is to measure a non-deterministic judge — a
red/green assertion on top of that would be a coin flip, not a signal.
What **does** run in CI, keylessly, is the harness's own **self-test**: a
scripted answer + a **stubbed** NLI verdict, asserting the grader/scorecard
math is wired correctly. That's a harness-integrity check, not a model-
quality check — it can't tell you the KB agent is grounded, only that the
grader would correctly say so if it were.

**NLI judge, current state:** the design's target judge is a dedicated
`mDeBERTa-v3-base-xnli` classifier served as an offline sidecar. That sidecar
doesn't exist yet. The current Node MVP (`llm-nli.ts`) uses an
instruction-following LLM (`ollama-cloud/gpt-oss:20b` by default, override
with `KB_EVAL_JUDGE_MODEL`) as the NLI judge instead, via a strict JSON-verdict
prompt (`buildNliPrompt`/`buildRelevancePrompt`) with a conservative parse
fallback (an unparseable reply counts _against_ groundedness, never for it).
Both the LLM judge and the future sidecar satisfy the same `NliClient`
interface (`nli.ts`), so swapping one for the other later touches no caller.

## The corpus decision

CI only ever sees one corpus: a **synthetic, fully-invented, committed**
corpus under `eval/kb/corpus/docs/` (~12 short documents, each authored to
exercise one specific failure mode: same-basename-different-folder,
near-duplicate passages, a fact split across two docs, a plausible distractor,
a DE/EN mirror pair, a topic mentioned but never answered). This is
deliberate on three counts: license-clean (no third-party content), immune to
overfitting (nobody can hand-tune retrieval against data the eval doesn't
see), and designed rather than found (every document earns its place by
catching a real regression class).

The real `/data/noack` corpus is an **optional, local-only** realism
sweep — `KB_EVAL_CORPUS_DIR=/path/to/noack KB_EVAL_CORPUS=noack pnpm -C
packages/web kb-eval:models` (a `--corpus=noack` CLI flag is also accepted;
the env var is checked as a fallback). It is never committed and never runs
in CI: `corpusFromEnv()` (`run-kb-eval.ts`) hard-errors if `noack` is
requested with `CI` set, unconditionally, with no way to override — the
check is deliberately loud rather than a silent fallback to the synthetic
corpus. **Noack ingest itself isn't wired yet** — selecting the noack corpus
today throws an explicit "no ingest path" error rather than silently
measuring against an empty index. That wiring is a guarded, explicit
local-only follow-up, not part of this harness's CI-facing surface.

## How to run each

```bash
# Layer 1 — runs automatically as part of the integration test suite:
pnpm -C packages/web test:db

# Layer 2 — the keyless attribution self-test (also runs automatically in the
# `integration` CI job; run it locally against the same stack):
pnpm -C packages/web kb-eval:selftest

# Regenerate the committed embedding fixtures (needs a reachable Ollama with
# bge-m3 pulled; only needed when the corpus or the embedding model changes —
# the resulting diff to embeddings.json should be reviewed like any other
# change to committed test data):
KB_EVAL_EMBED_URL=http://localhost:11434 pnpm kb-eval:reembed

# Layer 3 — the real, paid groundedness sweep (needs the eval stack up and
# OLLAMA_CLOUD_API_KEY):
OLLAMA_CLOUD_API_KEY=... pnpm -C packages/web kb-eval:models
```

`kb-eval:models` writes resumable JSONL to `eval/kb/results/` (gitignored —
a curated run is promoted into `eval/kb/data/`, which
`export-kb-scorecard.ts` consolidates into one scorecard, excluding
`run-infra-error` rows the same way the invoice harness's exporter excludes
harness-flake trials from a model's `n`).

## The threshold-calibration loop

The groundedness pass/fail threshold (τ, `DEFAULT_TAU = 0.6` in
`groundedness-grader.ts`) and the relevance threshold (0.5, in
`answer-graders.ts`) both start deliberately **strict** — the design's rule
is "start strict, loosen with data," not the reverse, because a threshold
that starts loose can hide a real regression before anyone has evidence to
notice. Layer 3's sweep over the DE/EN gold set is exactly that evidence: a
scorecard run against real models is the data source that calibrates both
thresholds over time. Loosening either default without a calibration run
backing the change defeats the point of starting strict — treat the sweep
output as the required justification, not a decorative artifact.

## Extending the harness

- **New corpus doc / failure mode**: add a `.md` under `eval/kb/corpus/docs/`
  and a `CorpusDoc` entry in `eval/kb/corpus/manifest.ts` with stable,
  author-declared chunk ids; add gold queries referencing those ids in
  `gold-queries.ts` (and `gold-qa.ts` if it needs a Layer-3 reference
  answer); regenerate fixtures with `kb-eval:reembed`.
- **New attribution defect**: add a pure grader to
  `src/lib/eval/kb/attribution-graders.ts`, wire it into `gradeAttribution`,
  add a fixture-based unit test, and add a matching fake-ollama trigger +
  self-test assertion in `e2e/integration/kb-attribution.spec.ts` so the
  defect is caught end-to-end, not just at the unit level.
- **New failure tag**: add it to `KbFailureTag` in
  `src/lib/eval/kb/types.ts` — every grader returns a `KbGraderResult`
  restricted to that union, so a new failure mode is always explicit and
  typed, never a free-text string.
