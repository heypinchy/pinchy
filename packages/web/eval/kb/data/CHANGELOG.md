# KB groundedness dataset — changelog

## 2026-08-05 — first published sweep (`kb-groundedness-2026-08-05.jsonl`)

48 runs: 12 gold questions × 4 candidate models × 1 run. **48 of 48 valid** —
no `run-infra-error` rows.

| model        | passed |
| ------------ | ------ |
| qwen3.5:397b | 5/12   |
| kimi-k2.6    | 4/12   |
| glm-5.2      | 3/12   |
| gpt-oss:120b | 0/12   |

Axis totals across all models: `citation-unresolved` 20, `sources-format` 17,
`ungrounded-claim` 17, `missed-abstention` 8, `off-topic-grounded` 7,
`source-uncited` 3.

**The headline is the shape, not the rate.** Citation discipline dominates:
markers that resolve to nothing and Sources lists that do not render as lists.
Groundedness is the smaller problem. That points at what the agent is taught
(`src/lib/skills/knowledge-search/SKILL.md`) rather than at model selection.

Caveats that belong next to any use of these numbers:

- **n is 12 per model.** A two-run gap between models is noise at this size.
- **7 of 48 runs have an empty premise set**, all of them answers that cite no
  source inline at all. `premiseSourcePaths` deliberately refuses to recover
  premises there — otherwise an answer that asserts and appends an uncited
  Sources list would pass. Their verdicts are correct; five of the seven carry
  `ungrounded-claim`, and on the one that carries nothing else, "cited nothing"
  would be the more precise label.
- **`freshness` and `crowding` have no gold questions** and therefore no data.

Both files carry the contamination-canary header line (see `README.md`). It is
the first line of each and is not a run; `totalRuns` counts 48.

### Why there is no earlier entry

Four sweeps ran before this one and none of them is published, because each was
measuring the harness. In order: a path rule that tested for `/` (three correct
citations in four charged as defects), a Sources parser that recognised only
`- [N]` (23 of 29 `ungrounded-claim` verdicts handed down against an empty
premise set), typographic punctuation from one model (its whole row), and a
row-shape drift between the sweep and the exporter (every axis would have
reported as untested). The raw runs are archived outside the repo; they are
kept as evidence of the failure modes, not as measurements.
