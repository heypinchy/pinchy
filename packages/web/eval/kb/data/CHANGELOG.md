# KB groundedness dataset — changelog

## 2026-08-10 — citation re-grade: `dedup-inflation` becomes reachable (#1181)

Same 48 answers, same file. Only the **citation** half of each verdict was
re-derived; the four judge-produced tags (`ungrounded-claim`,
`off-topic-grounded`, `missed-abstention`, `false-abstention`) and their notes
are carried over untouched, because the defect was in a pure grader and
re-running the judge would have re-rolled numbers the fix has nothing to say
about. `../data-reproducibility.test.ts` is what proves the result: it
re-derives these same citation verdicts from these same answers.

`dedup-inflation` could not fire. `gradeNoDuplicateCorroboration` passes
unconditionally on an empty `nearDuplicateGroups`, and no pipeline ever passed
one — the corpus knew its two duplicate pairs only in a header comment. Beneath
that sat a second defect: the grader compared a Sources entry's raw text against
an absolute corpus path (`/data/product-insert.md`), while every model in this
sweep cites the data-root-relative form `knowledge_search` prints, mostly inside
a code span. Wiring the groups through without fixing the comparison would have
produced the same 0 and looked like a fix.

| tag                | as published | this re-grade |
| ------------------ | ------------ | ------------- |
| `dedup-inflation`  | 0            | 4             |
| total runs passing | 31/48        | 28/48         |
| `dedup` axis       | 3/4          | 0/4           |

| model        | as published | this re-grade |
| ------------ | ------------ | ------------- |
| glm-5.2      | 9/12         | 8/12          |
| kimi-k2.6    | 9/12         | 8/12          |
| qwen3.5:397b | 7/12         | 6/12          |
| gpt-oss:120b | 7/12         | 6/12          |

All four charges land on `gqa-dedup-1` — the single gold question the `dedup`
axis exists for — and each was read by hand against what the model wrote. They
are genuine: every model answered "how often should the cartridge be replaced?"
by citing `quality-file.md` **and** `product-insert.md` as if two documents
independently confirmed the interval, when the second is a rewording of the
first. Three of those runs had been published as clean passes.

The models did not get worse. A check that was never running started running,
and the axis it belongs to turns out to be the one they all fail. Note which
direction the error ran: the harness was too lenient, and the symptom was a 0 —
the one value that reads as good news and gets no scrutiny.

## 2026-08-05 — first published sweep (`kb-groundedness-2026-08-05.jsonl`)

48 runs: 12 gold questions × 4 candidate models × 1 run. **48 of 48 valid** —
no `run-infra-error` rows.

The answers were measured on 2026-08-05. They were graded twice: once by the
sweep itself, and again on 2026-08-10 (`../regrade-kb-runs.ts`, judge
`ollama-cloud/gpt-oss:20b`) after two grader defects were fixed — #1163 replaced
an English phrase-list abstention detector with a judge, and #1173 widened a
Sources-list parser that recognised one entry shape. **The numbers below are the
re-grade.** The first grading is kept here, in the same table, because the size
of the gap is the most useful thing this dataset has to say.

| model        | as first graded | re-graded |
| ------------ | --------------- | --------- |
| glm-5.2      | 3/12            | 9/12      |
| kimi-k2.6    | 4/12            | 8/12      |
| qwen3.5:397b | 5/12            | 7/12      |
| gpt-oss:120b | 0/12            | 7/12      |

Axis totals across all models:

| tag                   | as first graded | re-graded |
| --------------------- | --------------- | --------- |
| `citation-unresolved` | 20              | 1         |
| `sources-format`      | 17              | 4         |
| `ungrounded-claim`    | 17              | 12        |
| `missed-abstention`   | 8               | 0         |
| `off-topic-grounded`  | 7               | 0         |
| `source-uncited`      | 3               | 6         |

**The published ranking was an artifact, and so is any ranking you read off the
new column.** The model that looked worst by a wide margin — 0 of 12, the number
that would have been quoted — is the one whose typography the Sources parser
could not read; corrected, it is indistinguishable from the field. Every one of
the 8 `missed-abstention` charges was an honest refusal the old detector could
not recognise, including all four German ones, which an English phrase list
could never have matched. At n = 12 the Wilson intervals for 9/12 and 7/12
overlap across most of their width, so the re-graded column separates no two
models either. It is a floor on how well these models can do the task, not an
ordering of them.

**The earlier headline is withdrawn.** This entry used to read "citation
discipline dominates: markers that resolve to nothing and Sources lists that do
not render as lists", and pointed at what the agent is taught rather than at
model selection. That claim rested on 20 `citation-unresolved` and 17
`sources-format`, of which 1 and 4 survive. The models were mostly writing
citations that resolve; the grader could not read them.

What is left, and looks real:

- **`ungrounded-claim`, 12 runs — exactly 3 per model.** The one axis the
  re-grade barely moved, and the only one that lands evenly across four very
  different models. That is the shape of a task property rather than a model
  property. Four of the twelve are runs that cite nothing inline at all (see
  the empty-premise note below), so the harder number is 8.
- **`source-uncited`, 6 runs** — a Sources list carrying an entry the answer
  never cites. This went UP (3 → 6), because five of these runs previously
  failed `citation-unresolved` instead: the parser could not see the list, so it
  charged the citation rather than the unused entry. The new label is the
  precise one.
- **`sources-format`, 4 runs** and **`citation-unresolved`, 1 run.** All five
  were read by hand against what the model wrote and are genuine: lists that
  really do collapse into one rendered paragraph, and one inline `[N]` with no
  matching entry.

Caveats that belong next to any use of these numbers:

- **n is 12 per model.** A two-run gap between models is noise at this size.
- **6 of 48 runs have an empty premise set**, all of them answers that cite no
  source inline. `premiseSourcePaths` deliberately refuses to recover premises
  there — otherwise an answer that asserts and appends an uncited Sources list
  would pass groundedness for free. Five of the six now carry `source-uncited`,
  which names what actually happened; the sixth is a correct abstention and
  passes.
- **`freshness` and `crowding` have no gold questions** and therefore no data.
- **The groundedness verdicts are not reproducible byte-for-byte.** They come
  from an LLM judge, so re-running `regrade-kb-runs.ts` will move a borderline
  sentence. The citation verdicts ARE reproducible, and
  `../data-reproducibility.test.ts` fails CI if they stop being — see
  `README.md`.

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

This sweep was the fifth, and it was written up before it was correct — the
table above is what that cost. The lesson is not "check harder": four of those
five defects were caught by reading trajectories, and the fifth was too, one
draft too late. It is that a dataset needs to survive its graders changing,
which is why the re-grade is a committed tool and the citation half has a guard.
