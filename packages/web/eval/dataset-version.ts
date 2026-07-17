/**
 * Semantic version of the published Eval-v1 dataset (pinchy#669, #802).
 *
 * Bump this in the SAME commit that changes what the dataset says — a re-grade
 * that flips outcomes, a model added, a scenario re-run — and record the change
 * in `data/CHANGELOG.md`. Old versions stay published and citable; this names
 * the current one.
 *
 * MAJOR: incompatible dataset shape or a re-grade that moves published numbers.
 * MINOR: additive — new models, new scenarios, new fields.
 * PATCH: corrections that don't move a published number (docs, metadata).
 */
export const DATASET_VERSION = "1.1.0";

/**
 * SHA-256 of every number this version publishes — the part that makes the rule
 * above enforceable rather than aspirational.
 *
 * `eval/__tests__/dataset-version.test.ts` re-computes this from the export on
 * every CI run and fails when it disagrees, so a commit that moves a published
 * number goes red until someone bumps DATASET_VERSION and records what moved.
 * Pinning the version to the changelog alone would not do that: both are edited
 * together, while the numbers live in `data/*.jsonl`, in the graders that
 * re-grade three scenarios at export time, and in the comparison statistics.
 *
 * It covers the whole exported payload minus the release metadata, so a field
 * added to the export moves it too — a new published number cannot ship
 * unhashed just because nobody remembered to widen a list.
 *
 * When this goes red, don't paste the new digest in. Work out what moved first;
 * the digest is the last line of the commit, not the first.
 */
export const DATASET_FINGERPRINT =
  "b8d2f224cfdaa080d16180a44c7656fd7fb0764f914c6b82679f7d8c7ba7eeba";
